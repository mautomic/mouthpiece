// InboxPanel.swift: the reply inbox panel (US-026). A floating panel that doesn't take focus,
// fed by GET /v1/inbox/events; replies go to POST /v1/reply and /v1/reply/submit.
import AppKit

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

// MARK: - Views

/// The panel's content view: tells the panel when the mouse enters, to cancel the pop-up's auto-hide.
final class HoverView: NSView {
  var onEnter: (() -> Void)?
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { onEnter?() }
}

final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// One session: header, response text, reply field, result line and Submit button.
final class InboxRow: NSView, NSTextFieldDelegate {
  static let width: CGFloat = 396
  private(set) var entry: InboxEntry
  let header = NSTextField(labelWithString: "")
  let body = NSTextField(wrappingLabelWithString: "")
  let more = NSButton(title: "Show full", target: nil, action: nil)
  let field = NSTextField()
  let result = NSTextField(wrappingLabelWithString: "")
  let submit = NSButton(title: "Submit", target: nil, action: nil)
  private var sending = false
  private var expanded = false
  private let onSend: (InboxRow, String) -> Void
  private let onSubmit: (InboxRow) -> Void
  private let onClose: () -> Void

  init(
    entry: InboxEntry, onSend: @escaping (InboxRow, String) -> Void, onSubmit: @escaping (InboxRow) -> Void,
    onClose: @escaping () -> Void
  ) {
    self.entry = entry
    self.onSend = onSend
    self.onSubmit = onSubmit
    self.onClose = onClose
    super.init(frame: .zero)
    header.font = .boldSystemFont(ofSize: NSFont.smallSystemFontSize)
    body.preferredMaxLayoutWidth = InboxRow.width
    result.preferredMaxLayoutWidth = InboxRow.width
    result.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    more.bezelStyle = .inline
    more.target = self
    more.action = #selector(toggleMore(_:))
    submit.bezelStyle = .rounded
    submit.target = self
    submit.action = #selector(submitPressed(_:))
    field.delegate = self
    field.lineBreakMode = .byTruncatingHead
    let stack = NSStackView(views: [header, body, more, field, result, submit])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 4
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
      field.widthAnchor.constraint(equalToConstant: InboxRow.width),
      widthAnchor.constraint(equalToConstant: InboxRow.width),
    ])
    result.isHidden = true
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  func update(_ entry: InboxEntry, now: Double) {
    self.entry = entry
    header.stringValue = "\(entry.name) · \(RowText.age((now - entry.at) / 1000)) · \(RowText.state(entry))"
    let text = entry.summary ?? entry.text
    body.stringValue = expanded ? entry.text : text
    body.maximumNumberOfLines = expanded ? 0 : 3
    more.isHidden = !expanded && text.count < 200 && entry.text == text
    more.title = expanded ? "Show less" : "Show full"
    field.isHidden = entry.route == nil
    field.isEnabled = entry.state == "waiting" && !sending
    field.placeholderString = RowText.placeholder(entry, sending: sending)
    submit.isHidden = entry.state != "typed" || entry.route == nil
  }

  func setSending(_ value: Bool) {
    sending = value
    update(entry, now: Date().timeIntervalSince1970 * 1000)
  }

  func show(_ outcome: ReplyOutcome) {
    result.stringValue = RowText.result(outcome)
    result.isHidden = false
    if outcome == .submitted { field.stringValue = "" }
  }

  @objc private func toggleMore(_ sender: NSButton) {
    expanded.toggle()
    update(entry, now: Date().timeIntervalSince1970 * 1000)
  }

  @objc private func submitPressed(_ sender: NSButton) { onSubmit(self) }

  private func send() {
    let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard field.isEnabled, !text.isEmpty else { return }
    onSend(self, text)
  }

  /// ⌘↩ sends; plain ↩ never does; Esc closes the panel. ⌘↩ may arrive as insertNewline: or as noop:.
  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    if let event = NSApp.currentEvent, event.type == .keyDown, event.keyCode == 36 || event.keyCode == 76,
      event.modifierFlags.contains(.command)
    {
      send()
      return true
    }
    if selector == #selector(NSResponder.insertNewline(_:)) { return true }
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      onClose()
      return true
    }
    return false
  }
}

// MARK: - Panel

final class InboxPanel: NSObject, NSWindowDelegate {
  static let width: CGFloat = 420
  static let popupHideSeconds: TimeInterval = 20
  let model = InboxModel()
  let mode: PopupMode
  private let token: () -> String
  private let panel: NSPanel
  private let rowsStack = NSStackView()
  private let emptyLabel = NSTextField(labelWithString: "Nothing yet")
  private var rows: [String: InboxRow] = [:]
  private var hideTimer: Timer?
  private var stream: InboxStream?
  var onCountChange: ((Int) -> Void)?

  init(baseURL: String, mode: PopupMode, token: @escaping () -> String) {
    self.mode = mode
    self.token = token
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: InboxPanel.width, height: 120),
      styleMask: [.titled, .closable, .utilityWindow, .nonactivatingPanel], backing: .buffered, defer: true)
    super.init()
    panel.title = "Mouthpiece inbox"
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.delegate = self

    let content = HoverView()
    content.onEnter = { [weak self] in self?.cancelHide() }
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    let document = FlippedView()
    document.translatesAutoresizingMaskIntoConstraints = false
    rowsStack.orientation = .vertical
    rowsStack.alignment = .leading
    rowsStack.spacing = 10
    rowsStack.translatesAutoresizingMaskIntoConstraints = false
    rowsStack.addArrangedSubview(emptyLabel)
    document.addSubview(rowsStack)
    scroll.documentView = document
    content.addSubview(scroll)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: content.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
      rowsStack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 12),
      rowsStack.trailingAnchor.constraint(lessThanOrEqualTo: document.trailingAnchor, constant: -12),
      rowsStack.topAnchor.constraint(equalTo: document.topAnchor, constant: 10),
      rowsStack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -10),
    ])
    panel.contentView = content

    if let url = URL(string: baseURL + "/v1/inbox/events") {
      stream = InboxStream(url: url, token: token) { [weak self] event, data in self?.handle(event: event, data: data) }
    }
  }

  func start() { stream?.start() }

  private func handle(event: String, data: String) {
    let fresh = model.apply(event: event, data: data)
    rebuild()
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    if fresh.contains(where: { shouldPop($0, mode: mode, frontmost: front) }) { popUp() }
  }

  /// Syncs the rows with the model, keeping each row's view (and its unsent text) while its id
  /// stays; a newer response's row takes over the unsent text of its conversation's old row.
  private func rebuild() {
    let now = Date().timeIntervalSince1970 * 1000
    let ordered = model.ordered
    let ids = Set(ordered.map(\.id))
    var drafts: [String: String] = [:]
    for (id, row) in rows where !ids.contains(id) {
      if !row.field.stringValue.isEmpty { drafts["\(row.entry.source)\u{0}\(row.entry.conversationId)"] = row.field.stringValue }
      row.removeFromSuperview()
      rows[id] = nil
    }
    var desired: [NSView] = []
    for entry in ordered {
      let row = rows[entry.id] ?? makeRow(entry)
      if rows[entry.id] == nil, let draft = drafts["\(entry.source)\u{0}\(entry.conversationId)"] {
        row.field.stringValue = draft
      }
      rows[entry.id] = row
      row.update(entry, now: now)
      desired.append(row)
    }
    if ordered.isEmpty { desired = [emptyLabel] }
    if rowsStack.arrangedSubviews != desired {
      let focused = (panel.firstResponder as? NSTextView).flatMap { editor in
        rows.values.first { $0.field.currentEditor() === editor }
      }
      for view in rowsStack.arrangedSubviews { rowsStack.removeArrangedSubview(view); view.removeFromSuperview() }
      for view in desired { rowsStack.addArrangedSubview(view) }
      if let focused, focused.superview != nil {
        panel.makeFirstResponder(focused.field)
        focused.field.currentEditor()?.selectedRange = NSRange(location: focused.field.stringValue.utf16.count, length: 0)
      }
    }
    resize()
    onCountChange?(model.waitingCount)
  }

  private func makeRow(_ entry: InboxEntry) -> InboxRow {
    InboxRow(
      entry: entry,
      onSend: { [weak self] row, text in self?.send(row, text) },
      onSubmit: { [weak self] row in self?.submit(row) },
      onClose: { [weak self] in self?.hide() })
  }

  private func send(_ row: InboxRow, _ text: String) {
    row.setSending(true)
    postReply(path: "/v1/reply", body: ["id": row.entry.id, "text": text], token: token()) { [weak row] outcome in
      row?.setSending(false)
      row?.show(outcome)
    }
  }

  private func submit(_ row: InboxRow) {
    row.setSending(true)
    postReply(path: "/v1/reply/submit", body: ["id": row.entry.id], token: token()) { [weak row] outcome in
      row?.setSending(false)
      row?.show(outcome)
    }
  }

  /// Up to 60% of the visible screen; past that the rows scroll. Keeps the top edge in place.
  private func resize() {
    guard let screen = panel.screen ?? NSScreen.main else { return }
    rowsStack.layoutSubtreeIfNeeded()
    let wanted = rowsStack.fittingSize.height + 20
    let height = min(max(wanted, 60), screen.visibleFrame.height * 0.6)
    let top = panel.frame.maxY
    panel.setContentSize(NSSize(width: InboxPanel.width, height: height))
    if panel.isVisible { panel.setFrameTopLeftPoint(NSPoint(x: panel.frame.minX, y: top)) }
  }

  /// Top right of the screen with the mouse.
  private func position() {
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    guard let visible = screen?.visibleFrame else { return }
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

  /// The hotkey or the menubar: in front and key, with the cursor in the newest waiting reply field.
  func showFocused() {
    if !panel.isVisible { position() }
    cancelHide()
    rebuild()
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    let target = model.ordered.first { $0.state == "waiting" && $0.route != nil } ?? model.ordered.first
    if let id = target?.id, let row = rows[id], !row.field.isHidden, row.field.isEnabled {
      panel.makeFirstResponder(row.field)
    }
  }

  func toggle() {
    if panel.isVisible && panel.isKeyWindow { hide() } else { showFocused() }
  }

  private func hide() {
    cancelHide()
    panel.orderOut(nil)
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
