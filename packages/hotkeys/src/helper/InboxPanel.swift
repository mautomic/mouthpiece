// InboxPanel.swift: the reply inbox panel (US-026). A floating panel that doesn't take focus,
// fed by GET /v1/inbox/events; replies go to POST /v1/reply and /v1/reply/submit.
import AppKit
import SwiftUI

// MARK: - Event stream

/// Follows GET /v1/inbox/events. Reconnects after a drop: 1 s, doubling to 30 s, reset after a
/// stream that lasted 60 s; a 401 or 404 waits 30 s. The token is re-read per connection, never logged.
final class InboxStream {
  private let url: URL
  private let token: () -> String
  private let onEvent: (String, String) -> Void
  private var task: Task<Void, Never>?
  private let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 30  // the daemon sends a keep-alive every 10 s
    config.timeoutIntervalForResource = 7 * 24 * 3600
    config.urlCache = nil
    return URLSession(configuration: config)
  }()

  init(url: URL, token: @escaping () -> String, onEvent: @escaping (String, String) -> Void) {
    self.url = url
    self.token = token
    self.onEvent = onEvent
  }

  func start() {
    task = Task { [weak self] in
      var delay: Double = 1
      while !Task.isCancelled {
        guard let self else { return }
        let started = Date()
        let refused = await self.follow()
        if Date().timeIntervalSince(started) >= 60 { delay = 1 }
        let wait = refused ? 30 : delay
        try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        delay = min(delay * 2, 30)
      }
    }
  }

  /// One connection; true when the daemon refused it (401 or 404).
  private func follow() async -> Bool {
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token())", forHTTPHeaderField: "Authorization")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    do {
      let (bytes, response) = try await session.bytes(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if status == 401 || status == 404 {
        log("inbox stream refused (HTTP \(status))")
        return true
      }
      guard status == 200 else { return false }
      var parser = SSEParser()
      var line: [UInt8] = []
      for try await byte in bytes {
        line.append(byte)
        guard byte == 0x0A else { continue }
        let events = parser.feed(line)
        line.removeAll(keepingCapacity: true)
        for e in events { await MainActor.run { self.onEvent(e.event, e.data) } }
      }
    } catch {
      // A drop or a stopped daemon; the loop reconnects.
    }
    return false
  }
}

// MARK: - Reply client

private let replySession: URLSession = {
  let config = URLSessionConfiguration.ephemeral
  config.timeoutIntervalForRequest = 25  // the daemon waits on the terminal for up to ~19 s
  config.urlCache = nil
  return URLSession(configuration: config)
}()

/// POSTs a reply or a submit; `done` runs on the main queue. The reply text is never logged.
func postReply(path: String, body: [String: String], token: String, done: @escaping (ReplyOutcome) -> Void) {
  guard let url = URL(string: baseURL + path), let data = try? JSONSerialization.data(withJSONObject: body) else {
    done(.refused(reason: "unreachable", error: ""))
    return
  }
  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.timeoutInterval = 25
  request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = data
  replySession.dataTask(with: request) { data, response, error in
    let status = error == nil ? ((response as? HTTPURLResponse)?.statusCode ?? 0) : 0
    let outcome = decodeReplyOutcome(status: status, body: data)
    DispatchQueue.main.async { done(outcome) }
  }.resume()
}

/** POSTs a JSON body to the daemon; `done` gets the HTTP status (0: no answer) on the main queue. */
func postDaemon(path: String, body: [String: Any], token: String, done: @escaping (Int) -> Void) {
  guard let url = URL(string: baseURL + path), let data = try? JSONSerialization.data(withJSONObject: body) else {
    done(0)
    return
  }
  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.timeoutInterval = 5
  request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = data
  replySession.dataTask(with: request) { _, response, error in
    let status = error == nil ? ((response as? HTTPURLResponse)?.statusCode ?? 0) : 0
    DispatchQueue.main.async { done(status) }
  }.resume()
}

// MARK: - Panel

/// The panel's translucent background. Its tracking area is `.activeAlways`, because during a pop-up
/// the helper is never the active app, and SwiftUI's hover only follows the active app. The mouse
/// entering cancels the pop-up's auto-hide.
final class InboxBackground: NSVisualEffectView {
  var onEnter: (() -> Void)?

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(
      NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { onEnter?() }
}

final class InboxPanel: NSObject, NSWindowDelegate {
  static let width: CGFloat = 420
  static let preferredHeight: CGFloat = 480
  static let popupHideSeconds: TimeInterval = 20
  let model = InboxModel()
  let viewModel = InboxViewModel()
  let mode: PopupMode
  private let token: () -> String
  private let panel: NSPanel
  private var hideTimer: Timer?
  private var stream: InboxStream?
  var onCountChange: ((Int) -> Void)?

  init(baseURL: String, mode: PopupMode, token: @escaping () -> String) {
    self.mode = mode
    self.token = token
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: InboxPanel.width, height: InboxPanel.preferredHeight),
      styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: true)
    super.init()
    panel.title = "Mouthpiece inbox"
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.delegate = self
    panel.titlebarAppearsTransparent = true
    panel.titleVisibility = .hidden
    panel.isOpaque = false
    panel.backgroundColor = .clear

    viewModel.actions = InboxActions(
      send: { [weak self] entry, text in self?.send(entry, text) },
      submit: { [weak self] entry in self?.submit(entry) },
      dismiss: { [weak self] entry in self?.dismiss(entry) },
      clearAll: { [weak self] in self?.clearAll() },
      hide: { [weak self] in self?.hide() },
      hovered: { [weak self] in self?.cancelHide() })

    let effect = InboxBackground()
    effect.onEnter = { [weak self] in self?.cancelHide() }
    effect.material = .popover
    effect.blendingMode = .behindWindow
    effect.state = .active
    let hosting = NSHostingView(rootView: InboxRootView(model: viewModel))
    hosting.sizingOptions = []
    hosting.translatesAutoresizingMaskIntoConstraints = false
    effect.addSubview(hosting)
    NSLayoutConstraint.activate([
      hosting.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
      hosting.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
      hosting.topAnchor.constraint(equalTo: effect.topAnchor),
      hosting.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
    ])
    panel.contentView = effect

    if let url = URL(string: baseURL + "/v1/inbox/events") {
      stream = InboxStream(url: url, token: token) { [weak self] event, data in self?.handle(event: event, data: data) }
    }
  }

  func start() { stream?.start() }

  private func handle(event: String, data: String) {
    let fresh = model.apply(event: event, data: data)
    viewModel.update(model.ordered)
    onCountChange?(model.waitingCount)
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    if fresh.contains(where: { shouldPop($0, mode: mode, frontmost: front) }) {
      viewModel.selectForPopUp(panelIsKey: panel.isKeyWindow)
      popUp()
    }
  }

  private func send(_ entry: InboxEntry, _ text: String) {
    let key = conversationKey(entry)
    viewModel.began(key)
    postReply(path: "/v1/reply", body: ["id": entry.id, "text": text], token: token()) { [weak self] outcome in
      self?.viewModel.finished(key, outcome, sent: text)
    }
  }

  private func submit(_ entry: InboxEntry) {
    let key = conversationKey(entry)
    viewModel.began(key)
    postReply(path: "/v1/reply/submit", body: ["id": entry.id], token: token()) { [weak self] outcome in
      self?.viewModel.finished(key, outcome, sent: nil)
    }
  }

  /// Removes an entry; the daemon's remove event takes the tab away. A reply in flight keeps it (409).
  private func dismiss(_ entry: InboxEntry) {
    let key = conversationKey(entry)
    postDaemon(path: "/v1/inbox/dismiss", body: ["id": entry.id], token: token()) { [weak self] status in
      if status == 409 { self?.viewModel.show(key, .refused(reason: "in-flight", error: "")) }
      if status == 0 { self?.viewModel.show(key, .refused(reason: "unreachable", error: "")) }
    }
  }

  private func clearAll() {
    postDaemon(path: "/v1/inbox/dismiss", body: ["all": true], token: token()) { status in
      if status != 200 { log("inbox clear failed (HTTP \(status))") }
    }
  }

  /// Top right of the screen with the mouse, min(480 pt, 60% of it) tall.
  private func position() {
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    guard let visible = screen?.visibleFrame else { return }
    let height = min(InboxPanel.preferredHeight, visible.height * 0.6)
    panel.setContentSize(NSSize(width: InboxPanel.width, height: height))
    panel.setFrameTopLeftPoint(NSPoint(x: visible.maxX - panel.frame.width - 12, y: visible.maxY - 12))
  }

  /// A pop-up: in front, never key, so your keystrokes stay where they were. Hides after 20 s untouched.
  private func popUp() {
    if !panel.isVisible { position() }
    panel.orderFrontRegardless()
    if !panel.isKeyWindow {
      hideTimer?.invalidate()
      hideTimer = Timer.scheduledTimer(withTimeInterval: InboxPanel.popupHideSeconds, repeats: false) { [weak self] _ in
        self?.hide()
      }
    }
  }

  /// The hotkey or the menubar: in front and key, on the newest waiting session, cursor in its reply box.
  func showFocused() {
    if !panel.isVisible { position() }
    cancelHide()
    viewModel.selectNewestWaiting()
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    viewModel.requestFocus()
  }

  func toggle() {
    if panel.isVisible && panel.isKeyWindow { hide() } else { showFocused() }
  }

  private func hide() {
    cancelHide()
    panel.orderOut(nil)
    // The hotkey path activated the helper; hand the keyboard back to the app that had it.
    if NSApp.isActive { NSApp.hide(nil) }
  }

  private func cancelHide() {
    hideTimer?.invalidate()
    hideTimer = nil
  }

  func windowDidBecomeKey(_ notification: Notification) { cancelHide() }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hide()
    return false
  }
}
