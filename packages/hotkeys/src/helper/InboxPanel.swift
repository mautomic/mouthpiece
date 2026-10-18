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
  /// 420 pt panel - 24 pt margins - room for an always-visible scroll bar.
  static let width: CGFloat = 380
  private(set) var entry: InboxEntry
  let header = NSTextField(labelWithString: "")
  let body = NSTextField(wrappingLabelWithString: "")
  let more = NSButton(title: "Show full", target: nil, action: nil)
  let field = NSTextField()
  let result = NSTextField(wrappingLabelWithString: "")
  let submit = NSButton(title: "Submit", target: nil, action: nil)
  private var sending = false
  private var expanded = false
  /// The text last delivered from this row (typed or submitted), so it is never carried over again.
  private(set) var lastSent: String?
  var onResize: (() -> Void)?
  private let onSend: (InboxRow, String) -> Void
  private let onSubmit: (InboxRow) -> Void
  private let onClose: () -> Void
  /// The row's × (POST /v1/inbox/dismiss); the row goes when the daemon's remove event arrives.
  var onDismiss: ((InboxRow) -> Void)?
  let dismissButton = NSButton(title: "×", target: nil, action: nil)

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
    dismissButton.isBordered = false
    dismissButton.toolTip = "Remove from the inbox"
    dismissButton.target = self
    dismissButton.action = #selector(dismissPressed(_:))
    header.setContentHuggingPriority(.defaultLow, for: .horizontal)
    header.lineBreakMode = .byTruncatingTail
    let top = NSStackView(views: [header, dismissButton])
    top.orientation = .horizontal
    let stack = NSStackView(views: [top, body, more, field, result, submit])
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
      top.widthAnchor.constraint(equalToConstant: InboxRow.width),
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

  func show(_ outcome: ReplyOutcome, sent text: String? = nil) {
    result.stringValue = RowText.result(outcome)
    result.isHidden = false
    if outcome == .submitted || outcome == .typed, let text { lastSent = text }
    if outcome == .submitted { field.stringValue = "" }
  }

  /// A carried-over draft: say why, so it isn't sent without reading the newer response.
  func showNewer() {
    result.stringValue = RowText.result(.refused(reason: "newer", error: ""))
    result.isHidden = false
  }

  @objc private func toggleMore(_ sender: NSButton) {
    expanded.toggle()
    update(entry, now: Date().timeIntervalSince1970 * 1000)
    onResize?()
  }

  @objc private func submitPressed(_ sender: NSButton) { onSubmit(self) }

  @objc private func dismissPressed(_ sender: NSButton) { onDismiss?(self) }

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
    let clearAll = NSButton(title: "Clear all", target: self, action: #selector(clearAllPressed(_:)))
    clearAll.bezelStyle = .inline
    clearAll.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(clearAll)
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
      clearAll.topAnchor.constraint(equalTo: content.topAnchor, constant: 6),
      clearAll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
      scroll.topAnchor.constraint(equalTo: clearAll.bottomAnchor, constant: 4),
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

  /// Syncs the rows with the model. Rows that stay are never moved or re-added, so the one being
  /// typed in keeps its text, caret and focus; new rows are inserted around them. A newer response's
  /// row takes over its conversation's unsent text (never text already delivered) with a notice.
  private func rebuild() {
    let now = Date().timeIntervalSince1970 * 1000
    let ordered = model.ordered
    let ids = Set(ordered.map(\.id))
    let editing = (panel.firstResponder as? NSTextView).flatMap { editor in
      rows.values.first { $0.field.currentEditor() === editor }
    }
    var drafts: [String: String] = [:]
    var refocus: String?
    for (id, row) in rows where !ids.contains(id) {
      let key = "\(row.entry.source)\u{0}\(row.entry.conversationId)"
      if let draft = carriedDraft(text: row.field.stringValue, lastSent: row.lastSent) { drafts[key] = draft }
      if row === editing { refocus = key }
      rowsStack.removeArrangedSubview(row)
      row.removeFromSuperview()
      rows[id] = nil
    }
    var desired: [InboxRow] = []
    var focusTarget: InboxRow?
    for entry in ordered {
      let key = "\(entry.source)\u{0}\(entry.conversationId)"
      let row: InboxRow
      if let existing = rows[entry.id] {
        row = existing
      } else {
        row = makeRow(entry)
        if let draft = drafts[key] {
          row.field.stringValue = draft
          row.showNewer()
        }
        if refocus == key { focusTarget = row }
        rows[entry.id] = row
      }
      row.update(entry, now: now)
      desired.append(row)
    }
    emptyLabel.isHidden = !ordered.isEmpty
    if emptyLabel.superview == nil { rowsStack.addArrangedSubview(emptyLabel) }
    let current = rowsStack.arrangedSubviews.compactMap { $0 as? InboxRow }.map(\.entry.id)
    if keptInOrder(current: current, desired: desired.map(\.entry.id)) {
      for (index, row) in desired.enumerated() where row.superview == nil {
        rowsStack.insertArrangedSubview(row, at: index)
      }
    } else {
      // Rare (equal ages are ordered by id): re-add every row, then put the caret back where it was.
      let selection = editing?.field.currentEditor()?.selectedRange
      for row in desired {
        rowsStack.removeArrangedSubview(row)
        row.removeFromSuperview()
      }
      for (index, row) in desired.enumerated() { rowsStack.insertArrangedSubview(row, at: index) }
      if let editing, editing.superview != nil {
        panel.makeFirstResponder(editing.field)
        if let selection { editing.field.currentEditor()?.selectedRange = selection }
      }
    }
    if let focusTarget, !focusTarget.field.isHidden { panel.makeFirstResponder(focusTarget.field) }
    resize()
    onCountChange?(model.waitingCount)
  }

  private func makeRow(_ entry: InboxEntry) -> InboxRow {
    let row = InboxRow(
      entry: entry,
      onSend: { [weak self] row, text in self?.send(row, text) },
      onSubmit: { [weak self] row in self?.submit(row) },
      onClose: { [weak self] in self?.hide() })
    row.onResize = { [weak self] in self?.resize() }
    row.onDismiss = { [weak self] row in self?.dismiss(row) }
    return row
  }

  private func send(_ row: InboxRow, _ text: String) {
    row.setSending(true)
    postReply(path: "/v1/reply", body: ["id": row.entry.id, "text": text], token: token()) { [weak row] outcome in
      row?.setSending(false)
      row?.show(outcome, sent: text)
    }
  }

  /// Removes an entry; the daemon's remove event takes the row away. A reply in flight keeps it (409).
  private func dismiss(_ row: InboxRow) {
    postDaemon(path: "/v1/inbox/dismiss", body: ["id": row.entry.id], token: token()) { [weak row] status in
      if status == 409 { row?.show(.refused(reason: "in-flight", error: "")) }
      if status == 0 { row?.show(.refused(reason: "unreachable", error: "")) }
    }
  }

  @objc private func clearAllPressed(_ sender: NSButton) {
    postDaemon(path: "/v1/inbox/dismiss", body: ["all": true], token: token()) { status in
      if status != 200 { log("inbox clear failed (HTTP \(status))") }
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
    let wanted = rowsStack.fittingSize.height + 20 + 30  // rows, margins, the Clear all bar
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
