// InboxCore.swift: the reply inbox's logic (US-026). No AppKit, so `--self-test-inbox` checks it offline.
import Foundation

// MARK: - Server-sent events

/// Splits a `text/event-stream` into `(event, data)` pairs. Bytes may arrive in any chunks.
struct SSEParser {
  private var buffer: [UInt8] = []
  private var event = ""
  private var data: [String] = []

  mutating func feed(_ chunk: [UInt8]) -> [(event: String, data: String)] {
    buffer.append(contentsOf: chunk)
    var out: [(event: String, data: String)] = []
    while let newline = buffer.firstIndex(of: 0x0A) {
      var line = Array(buffer[..<newline])
      buffer.removeFirst(newline + 1)
      if line.last == 0x0D { line.removeLast() }
      let text = String(decoding: line, as: UTF8.self)
      if text.isEmpty {
        if !data.isEmpty {
          out.append((event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n")))
        }
        event = ""
        data = []
      } else if text.hasPrefix(":") {
        continue  // a comment: the keep-alive
      } else if text.hasPrefix("event:") {
        event = SSEParser.value(text, field: "event:")
      } else if text.hasPrefix("data:") {
        data.append(SSEParser.value(text, field: "data:"))
      }
    }
    return out
  }

  private static func value(_ line: String, field: String) -> String {
    let rest = line.dropFirst(field.count)
    return String(rest.first == " " ? rest.dropFirst() : rest)
  }
}

// MARK: - Entries (mirrors InboxEntry in packages/core/src/contracts.ts)

struct InboxRoute: Decodable, Equatable {
  let via: String
  let target: String
  let agent: String
}

struct InboxEntry: Decodable, Equatable {
  let id: String
  let source: String
  let conversationId: String
  let label: String?
  let text: String
  let summary: String?
  let at: Double
  let route: InboxRoute?
  let state: String
  /// "pending" until the voice starts, then "started"; "none" when it won't be spoken. Absent from
  /// older daemons, which counts as started.
  var speech: String? = nil
  /// True when the response's mode was `off`: it never pops the panel. Absent from older daemons.
  var muted: Bool? = nil

  var name: String { label ?? source }
  var speechPending: Bool { speech == "pending" }
}

private struct InboxSnapshot: Decodable {
  let enabled: Bool
  let entries: [InboxEntry]
}

private struct InboxRemoval: Decodable {
  let id: String
}

/// The panel's rows, fed by the event stream. One row per conversation.
final class InboxModel {
  private(set) var entries: [String: InboxEntry] = [:]
  private(set) var enabled = false
  /// Ids already heard (or there before the first snapshot), so each pops up at most once.
  private var announced = Set<String>()
  private var started = false

  /// Applies one stream event. Returns the entries that are new: an id not announced yet, arriving
  /// after the first snapshot, once its speech is no longer pending (so a pop-up comes with the
  /// voice, not ahead of it). A snapshot (start-up or reconnect) is never new itself.
  func apply(event: String, data: String) -> [InboxEntry] {
    let bytes = Data(data.utf8)
    let decoder = JSONDecoder()
    switch event {
    case "snapshot":
      guard let snapshot = try? decoder.decode(InboxSnapshot.self, from: bytes) else { return [] }
      enabled = snapshot.enabled
      entries = Dictionary(snapshot.entries.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
      announced.formUnion(entries.values.filter { !$0.speechPending }.map(\.id))
      started = true
      return []
    case "entry":
      guard let entry = try? decoder.decode(InboxEntry.self, from: bytes) else { return [] }
      // A newer response replaces its conversation's row (the daemon sends no remove for it).
      entries = entries.filter {
        $0.key == entry.id || $0.value.source != entry.source || $0.value.conversationId != entry.conversationId
      }
      entries[entry.id] = entry
      if entry.speechPending && started { return [] }
      let isNew = started && !announced.contains(entry.id)
      announced.insert(entry.id)
      return isNew ? [entry] : []
    case "remove":
      guard let removal = try? decoder.decode(InboxRemoval.self, from: bytes) else { return [] }
      entries[removal.id] = nil
      return []
    default:
      return []
    }
  }

  /// Newest first.
  var ordered: [InboxEntry] { entries.values.sorted { $0.at != $1.at ? $0.at > $1.at : $0.id < $1.id } }

  /// Entries waiting for a reply that can be sent from here.
  var waitingCount: Int { entries.values.filter { $0.state == "waiting" && $0.route != nil }.count }
}

// MARK: - Row rules

/**
 * The unsent text a newer response's row takes over from its conversation's old row: none when it's
 * blank, or when it is exactly the text already delivered (typed or submitted), so it can't be sent twice.
 */
func carriedDraft(text: String, lastSent: String?) -> String? {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty || trimmed == lastSent { return nil }
  return text
}

/** After the row at `removedAt` goes, the index of the row the cursor moves to (nil: none left). */
func nextFocusIndex(removedAt: Int, remaining: Int) -> Int? {
  remaining == 0 ? nil : min(removedAt, remaining - 1)
}

/** True when the rows that stay keep their order, so new rows can be inserted without moving any. */
func keptInOrder(current: [String], desired: [String]) -> Bool {
  let wanted = Set(desired)
  let present = Set(current)
  return current.filter { wanted.contains($0) } == desired.filter { present.contains($0) }
}

// MARK: - Pop-up policy ([reply] popup)

enum PopupMode: String {
  case away, always, never
}

/// Terminal host (a route's `via`) → its app's bundle id, for "away".
let hostBundleIds: [String: String] = ["orca": "com.stablyai.orca"]

/// Whether a new entry pops the panel up. Only unmuted waiting entries with a route ever do.
func shouldPop(_ entry: InboxEntry, mode: PopupMode, frontmost: String?) -> Bool {
  guard entry.state == "waiting", let route = entry.route, entry.muted != true else { return false }
  switch mode {
  case .always: return true
  case .never: return false
  case .away:
    guard let host = hostBundleIds[route.via] else { return true }
    return frontmost != host
  }
}

// MARK: - Reply outcomes (POST /v1/reply, /v1/reply/submit)

enum ReplyOutcome: Equatable {
  case submitted
  case typed
  case refused(reason: String, error: String)
}

/// `status` 0 means the request never got an answer.
func decodeReplyOutcome(status: Int, body: Data?) -> ReplyOutcome {
  let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
  if status == 202, let value = json?["status"] as? String {
    if value == "submitted" { return .submitted }
    if value == "typed" { return .typed }
  }
  if status == 0 { return .refused(reason: "unreachable", error: "") }
  return .refused(reason: json?["reason"] as? String ?? "", error: json?["error"] as? String ?? "HTTP \(status)")
}

// MARK: - Row text

enum RowText {
  static func state(_ entry: InboxEntry) -> String {
    guard entry.route != nil else { return "Can't reply here" }
    switch entry.state {
    case "waiting": return "Waiting for you"
    case "busy": return "Working…"
    case "sending": return "Sending…"
    case "typed": return "Typed, not submitted"
    default: return entry.state
    }
  }

  /// The reply field's placeholder: why it is off, or how to send.
  static func placeholder(_ entry: InboxEntry, sending: Bool) -> String {
    if sending || entry.state == "sending" { return "Sending…" }
    switch entry.state {
    case "busy": return "The agent is working"
    case "typed": return "Press Submit, or reply in the terminal"
    default: return "Reply (⌘↩ to send)"
    }
  }

  static func result(_ outcome: ReplyOutcome) -> String {
    switch outcome {
    case .submitted: return "Sent ✓"
    case .typed: return "Typed but not submitted. Check the terminal, or press Submit."
    case .refused(let reason, let error):
      switch reason {
      case "newer": return "A newer response arrived; read it first."
      case "busy", "not-idle": return "The agent is working; try again when it's done."
      case "draft": return "There's text at that prompt already."
      case "not-agent", "gone": return "That session's terminal has changed or closed."
      case "unverified": return "Couldn't check the terminal; nothing was typed."
      case "in-flight": return "A reply is already on its way."
      case "disabled": return "Replies are off ([reply] enabled)."
      case "no-route": return "Can't reply to this session from here."
      case "too-long": return "That's over 4,000 characters."
      case "send-failed": return "Typing into the terminal failed; check it before retrying."
      case "unreachable": return "Mouthpiece isn't reachable."
      default: return error
      }
    }
  }

  static func age(_ seconds: Double) -> String {
    let s = max(0, Int(seconds.rounded()))
    if s < 60 { return "\(s)s" }
    if s < 3600 { return "\(s / 60)m" }
    return "\(s / 3600)h"
  }
}

// MARK: - Tabs (the Conversation layout)

/// A tab is a conversation, so a newer response keeps its tab (and selection).
func conversationKey(_ entry: InboxEntry) -> String { "\(entry.source)\u{0}\(entry.conversationId)" }

enum TabSelection {
  /// The newest conversation waiting for a reply that can be sent from here.
  static func newestWaiting(_ ordered: [InboxEntry]) -> String? {
    ordered.first { $0.state == "waiting" && $0.route != nil }.map(conversationKey)
  }

  /// Keep `selected` while it has an entry; else the newest waiting, else the newest, else nil.
  static func resolve(selected: String?, ordered: [InboxEntry]) -> String? {
    if let selected, ordered.contains(where: { conversationKey($0) == selected }) { return selected }
    return newestWaiting(ordered) ?? ordered.first.map(conversationKey)
  }
}

/// ⌘1…⌘9: the tab index for a digit, or nil when there's no such tab.
func tabIndex(digit: Int, count: Int) -> Int? {
  guard (1...9).contains(digit), digit <= count else { return nil }
  return digit - 1
}

/// ⌃⇥ / ⌃⇧⇥: the next or previous tab, wrapping round.
func cycledIndex(current: Int, count: Int, forward: Bool) -> Int {
  guard count > 0 else { return 0 }
  return (current + (forward ? 1 : count - 1)) % count
}

enum TabDot: Equatable {
  case waiting, working, typed, none

  static func of(_ entry: InboxEntry) -> TabDot {
    guard entry.route != nil else { return .none }
    switch entry.state {
    case "waiting": return .waiting
    case "busy", "sending": return .working
    case "typed": return .typed
    default: return .none
    }
  }
}

/// "<label> · <agent> · <age> ago". The agent is `route.agent` as sent; without a route, the source,
/// shown once when there's no label either.
func metaLine(_ entry: InboxEntry, now: Double) -> String {
  var parts = [entry.name]
  if let agent = entry.route?.agent {
    parts.append(agent)
  } else if entry.label != nil {
    parts.append(entry.source)
  }
  parts.append("\(RowText.age((now - entry.at) / 1000)) ago")
  return parts.joined(separator: " · ")
}

// MARK: - Message (a preview of a long reply)

/// A long reply shows its first lines until expanded. The panel never shows the spoken summary:
/// it arrives a moment after the reply and would swap the text under the reader.
let previewLines = 6
let previewChars = 400

/// The reply cut to `previewLines` lines and `previewChars` characters (at a word), with "…";
/// nil when it fits whole.
func messagePreview(_ text: String) -> String? {
  var t = text
  while let last = t.last, last.isWhitespace { t.removeLast() }
  var cut = t
  let lines = cut.split(separator: "\n", omittingEmptySubsequences: false)
  if lines.count > previewLines { cut = lines.prefix(previewLines).joined(separator: "\n") }
  if cut.count > previewChars {
    let end = cut.index(cut.startIndex, offsetBy: previewChars)
    var head = cut[..<end]
    if !cut[end].isWhitespace, let space = head.lastIndex(where: { $0.isWhitespace }) { head = head[..<space] }
    cut = String(head)
  }
  while let last = cut.last, last.isWhitespace { cut.removeLast() }
  return cut == t ? nil : cut + "…"
}

/// What the message area shows, and the toggle's title (nil when the reply fits whole).
struct MessageDisplay: Equatable {
  let text: String
  let toggle: String?
  /// Shown in place of the text, dimmed: the reply isn't being read out yet.
  var placeholder = false
}

func messageDisplay(_ entry: InboxEntry, expanded: Bool) -> MessageDisplay {
  // No spoilers: the text shows once the voice starts reading it.
  if entry.speechPending { return MessageDisplay(text: "Speaking soon…", toggle: nil, placeholder: true) }
  guard let preview = messagePreview(entry.text) else { return MessageDisplay(text: entry.text, toggle: nil) }
  return expanded
    ? MessageDisplay(text: entry.text, toggle: "Show less")
    : MessageDisplay(text: preview, toggle: "Show full response")
}

// MARK: - Self-test (--self-test-inbox)

/// Checks the inbox logic offline. Prints "ok" and returns 0, or one "FAIL <case>" line per failure and 1.
func runInboxSelfTest() -> Int32 {
  var failures: [String] = []
  func check(_ ok: Bool, _ name: String) { if !ok { failures.append(name) } }

  func entryJSON(
    _ id: String, conv: String = "c1", state: String = "waiting", route: Bool = true, at: Double = 1,
    label: String? = "web", speech: String? = nil, muted: Bool = false
  ) -> String {
    let r = route ? ",\"route\":{\"via\":\"orca\",\"target\":\"term_a\",\"agent\":\"claude\"}" : ""
    let l = (label.map { ",\"label\":\"\($0)\"" } ?? "") + (speech.map { ",\"speech\":\"\($0)\"" } ?? "")
      + (muted ? ",\"muted\":true" : "")
    return "{\"id\":\"\(id)\",\"source\":\"claude-code\",\"conversationId\":\"\(conv)\"\(l),"
      + "\"text\":\"Shall I continue?\",\"at\":\(at),\"state\":\"\(state)\"\(r),\"alert\":{\"text\":\"x\",\"at\":1}}"
  }
  func snapshotJSON(_ entries: [String]) -> String { "{\"enabled\":true,\"entries\":[\(entries.joined(separator: ","))]}" }
  func bytes(_ s: String) -> [UInt8] { Array(s.utf8) }
  func names(_ events: [(event: String, data: String)]) -> [String] { events.map { "\($0.event)|\($0.data)" } }

  // SSEParser
  let stream = "event: snapshot\ndata: {\"a\":1}\n\n: keepalive\n\nevent: entry\ndata: line1\ndata: line2\n\nevent: remove\ndata: {\"id\":\"e9\"}\n\n"
  var whole = SSEParser()
  let expected = ["snapshot|{\"a\":1}", "entry|line1\nline2", "remove|{\"id\":\"e9\"}"]
  check(names(whole.feed(bytes(stream))) == expected, "sse: snapshot, multi-line data, keepalive, remove")
  let all = bytes(stream)
  var splitOK = true
  for cut in 0...all.count {
    var p = SSEParser()
    let got = names(p.feed(Array(all[0..<cut])) + p.feed(Array(all[cut...])))
    if got != expected { splitOK = false }
  }
  check(splitOK, "sse: an event split at every byte offset")
  var crlf = SSEParser()
  check(names(crlf.feed(bytes("event: entry\r\ndata: x\r\n\r\n"))) == ["entry|x"], "sse: CRLF line ends")

  // InboxModel
  let model = InboxModel()
  check(model.apply(event: "entry", data: entryJSON("e0")).isEmpty, "model: an entry before any snapshot pops nothing")
  check(model.apply(event: "snapshot", data: snapshotJSON([entryJSON("e1")])).isEmpty, "model: the snapshot pops nothing")
  check(model.enabled, "model: snapshot sets enabled")
  check(model.waitingCount == 1, "model: waiting count after snapshot")
  check(model.apply(event: "entry", data: entryJSON("e2", conv: "c2", at: 5)).map(\.id) == ["e2"], "model: a new id is new")
  check(model.apply(event: "entry", data: entryJSON("e2", conv: "c2", state: "busy", at: 5)).isEmpty, "model: a repeated id is not new")
  check(model.waitingCount == 1, "model: busy entries are not waiting")
  _ = model.apply(event: "entry", data: entryJSON("e3", conv: "c1", at: 9))
  check(model.ordered.map(\.id) == ["e3", "e2"], "model: a newer response replaces its conversation's row; newest first")
  _ = model.apply(event: "entry", data: entryJSON("e4", conv: "c4", route: false, at: 2))
  check(model.waitingCount == 1, "model: an entry with no route is not counted as waiting")
  _ = model.apply(event: "remove", data: "{\"id\":\"e2\"}")
  check(!model.ordered.contains { $0.id == "e2" }, "model: remove")
  check(model.apply(event: "snapshot", data: snapshotJSON([entryJSON("e7", conv: "c7")])).isEmpty, "model: reconnect snapshot pops nothing")
  check(model.ordered.map(\.id) == ["e7"], "model: a snapshot replaces the rows")
  check(model.apply(event: "entry", data: entryJSON("e7", conv: "c7", state: "busy")).isEmpty, "model: an id from a snapshot is not new")
  check(model.apply(event: "entry", data: "not json").isEmpty && model.apply(event: "other", data: "{}").isEmpty, "model: garbage is ignored")
  // Pop-ups wait for the voice: a pending entry is new only once its speech starts (or won't happen)
  check(model.apply(event: "entry", data: entryJSON("v1", conv: "v1", speech: "pending")).isEmpty, "model: a pending entry pops nothing yet")
  check(model.ordered.contains { $0.id == "v1" }, "model: a pending entry still gets its tab")
  check(model.apply(event: "entry", data: entryJSON("v1", conv: "v1", speech: "started")).map(\.id) == ["v1"], "model: it is new once its speech starts")
  check(model.apply(event: "entry", data: entryJSON("v1", conv: "v1", state: "busy", speech: "started")).isEmpty, "model: and only once")
  check(model.apply(event: "entry", data: entryJSON("v2", conv: "v2", speech: "none")).map(\.id) == ["v2"], "model: an unspoken entry is new at once")
  _ = model.apply(event: "snapshot", data: snapshotJSON([entryJSON("v3", conv: "v3", speech: "pending")]))
  check(model.apply(event: "entry", data: entryJSON("v3", conv: "v3", speech: "started")).map(\.id) == ["v3"], "model: a pending entry from a reconnect snapshot pops when its speech starts")
  let pending = try! JSONDecoder().decode(InboxEntry.self, from: Data(entryJSON("v4", speech: "pending").utf8))
  check(messageDisplay(pending, expanded: true) == MessageDisplay(text: "Speaking soon…", toggle: nil, placeholder: true), "message: a pending entry hides its text")
  let unlabeled = try? JSONDecoder().decode(InboxEntry.self, from: Data(entryJSON("e8", label: nil).utf8))
  check(unlabeled?.name == "claude-code", "model: name falls back to the source")

  // PopupPolicy
  let waiting = try! JSONDecoder().decode(InboxEntry.self, from: Data(entryJSON("p1").utf8))
  let busy = try! JSONDecoder().decode(InboxEntry.self, from: Data(entryJSON("p2", state: "busy").utf8))
  let noRoute = try! JSONDecoder().decode(InboxEntry.self, from: Data(entryJSON("p3", route: false).utf8))
  let orca = "com.stablyai.orca"
  check(shouldPop(waiting, mode: .always, frontmost: orca), "popup: always pops even in Orca")
  check(!shouldPop(waiting, mode: .never, frontmost: "com.apple.Safari"), "popup: never never pops")
  check(!shouldPop(waiting, mode: .away, frontmost: orca), "popup: away stays quiet while Orca is in front")
  check(shouldPop(waiting, mode: .away, frontmost: "com.apple.Safari"), "popup: away pops in another app")
  check(shouldPop(waiting, mode: .away, frontmost: nil), "popup: away pops with no app in front")
  let otherVia = InboxEntry(
    id: "p4", source: "x", conversationId: "c", label: nil, text: "t", summary: nil, at: 1,
    route: InboxRoute(via: "tmux", target: "%1", agent: "claude"), state: "waiting")
  check(shouldPop(otherVia, mode: .away, frontmost: orca), "popup: an unknown via counts as away")
  check(!shouldPop(busy, mode: .always, frontmost: nil), "popup: a busy entry never pops")
  check(!shouldPop(noRoute, mode: .always, frontmost: nil), "popup: an entry with no route never pops")
  let mutedEntry = try! JSONDecoder().decode(InboxEntry.self, from: Data(entryJSON("p7", muted: true).utf8))
  check(!shouldPop(mutedEntry, mode: .always, frontmost: nil), "popup: a muted (mode off) entry never pops")

  // Reply outcomes
  check(decodeReplyOutcome(status: 202, body: Data("{\"status\":\"submitted\"}".utf8)) == .submitted, "reply: 202 submitted")
  check(decodeReplyOutcome(status: 202, body: Data("{\"status\":\"typed\"}".utf8)) == .typed, "reply: 202 typed")
  check(
    decodeReplyOutcome(status: 409, body: Data("{\"error\":\"the prompt is not empty\",\"reason\":\"draft\"}".utf8))
      == .refused(reason: "draft", error: "the prompt is not empty"), "reply: 409 refusal")
  check(decodeReplyOutcome(status: 0, body: nil) == .refused(reason: "unreachable", error: ""), "reply: transport failure")
  check(decodeReplyOutcome(status: 500, body: Data("oops".utf8)) == .refused(reason: "", error: "HTTP 500"), "reply: garbled body")

  // RowText
  check(RowText.state(waiting) == "Waiting for you", "text: waiting")
  check(RowText.state(busy) == "Working…", "text: busy")
  check(RowText.state(noRoute) == "Can't reply here", "text: no route")
  let typedEntry = try! JSONDecoder().decode(InboxEntry.self, from: Data(entryJSON("p5", state: "typed").utf8))
  let sendingEntry = try! JSONDecoder().decode(InboxEntry.self, from: Data(entryJSON("p6", state: "sending").utf8))
  check(RowText.state(typedEntry) == "Typed, not submitted", "text: typed")
  check(RowText.state(sendingEntry) == "Sending…", "text: sending")
  check(RowText.placeholder(busy, sending: false) == "The agent is working", "placeholder: busy")
  check(RowText.placeholder(waiting, sending: true) == "Sending…", "placeholder: sending")
  check(RowText.placeholder(typedEntry, sending: false) == "Press Submit, or reply in the terminal", "placeholder: typed")
  let results: [(ReplyOutcome, String)] = [
    (.submitted, "Sent ✓"),
    (.typed, "Typed but not submitted. Check the terminal, or press Submit."),
    (.refused(reason: "newer", error: ""), "A newer response arrived; read it first."),
    (.refused(reason: "busy", error: ""), "The agent is working; try again when it's done."),
    (.refused(reason: "not-idle", error: ""), "The agent is working; try again when it's done."),
    (.refused(reason: "draft", error: ""), "There's text at that prompt already."),
    (.refused(reason: "not-agent", error: ""), "That session's terminal has changed or closed."),
    (.refused(reason: "gone", error: ""), "That session's terminal has changed or closed."),
    (.refused(reason: "unverified", error: ""), "Couldn't check the terminal; nothing was typed."),
    (.refused(reason: "in-flight", error: ""), "A reply is already on its way."),
    (.refused(reason: "disabled", error: ""), "Replies are off ([reply] enabled)."),
    (.refused(reason: "no-route", error: ""), "Can't reply to this session from here."),
    (.refused(reason: "too-long", error: ""), "That's over 4,000 characters."),
    (.refused(reason: "send-failed", error: ""), "Typing into the terminal failed; check it before retrying."),
    (.refused(reason: "unreachable", error: ""), "Mouthpiece isn't reachable."),
    (.refused(reason: "", error: "HTTP 500"), "HTTP 500"),
  ]
  for (outcome, text) in results { check(RowText.result(outcome) == text, "text: result \(outcome)") }
  check(RowText.age(5) == "5s" && RowText.age(125) == "2m" && RowText.age(3 * 3600 + 5) == "3h", "text: age")

  // Review fixes: carried drafts, stable order, rows kept in place
  check(carriedDraft(text: "yes", lastSent: nil) == "yes", "draft: unsent text carries to a newer response")
  check(carriedDraft(text: "yes", lastSent: "yes") == nil, "draft: text already delivered does not carry")
  check(carriedDraft(text: "  ", lastSent: nil) == nil, "draft: blank text does not carry")
  check(carriedDraft(text: "yes, and also", lastSent: "yes") == "yes, and also", "draft: text edited after sending carries")
  let tie = InboxModel()
  _ = tie.apply(event: "snapshot", data: snapshotJSON([entryJSON("b", conv: "c1", at: 3), entryJSON("a", conv: "c2", at: 3), entryJSON("c", conv: "c3", at: 3)]))
  check(tie.ordered.map(\.id) == ["a", "b", "c"], "model: equal times are ordered by id")
  check(keptInOrder(current: ["a", "b"], desired: ["n", "a", "b"]), "rows: a new row on top keeps the others in place")
  check(keptInOrder(current: ["a", "b", "c"], desired: ["a", "c"]), "rows: a removal keeps the others in place")
  check(!keptInOrder(current: ["a", "b"], desired: ["b", "a"]), "rows: a swap needs a rebuild")

  // ⌘⌫ removes a row: the cursor moves to the row that takes its place
  check(nextFocusIndex(removedAt: 1, remaining: 3) == 1, "focus: the next row takes the removed row's place")
  check(nextFocusIndex(removedAt: 3, remaining: 3) == 2, "focus: removing the last row moves to the one above")
  check(nextFocusIndex(removedAt: 0, remaining: 0) == nil, "focus: nothing left, no focus")

  // Menu shortcuts: a hotkey binding shown on its menu item (keyCodes and modifierMasks are main.swift's)
  let inboxKey = Binding(
    action: "inbox", keyCode: keyCodes["i"]!, modifiers: UInt32(modifierMasks["ctrl"]! | modifierMasks["alt"]!))
  check(menuShortcut(inboxKey).map { "\($0.key) \($0.modifiers)" } == "i [\"ctrl\", \"alt\"]", "menu: ctrl+alt+i")
  let everyModifier = Binding(
    action: "stop", keyCode: keyCodes["s"]!,
    modifiers: UInt32(modifierMasks["cmd"]! | modifierMasks["shift"]! | modifierMasks["ctrl"]! | modifierMasks["alt"]!))
  check(menuShortcut(everyModifier)?.modifiers == ["ctrl", "alt", "shift", "cmd"], "menu: every modifier, in menu order")
  check(menuShortcut(Binding(action: "stop", keyCode: 999, modifiers: 0)) == nil, "menu: an unknown key shows nothing")

  // Redesign: tabs (selection by conversation), digits, cycling, dots, meta line
  func entry(_ id: String, conv: String, state: String = "waiting", route: Bool = true, label: String? = "web", at: Double = 1)
    -> InboxEntry
  {
    InboxEntry(
      id: id, source: "agent", conversationId: conv, label: label, text: "t", summary: nil, at: at,
      route: route ? InboxRoute(via: "orca", target: "term_a", agent: "claude") : nil, state: state)
  }
  let busyA = entry("a1", conv: "a", state: "busy", at: 9)
  let waitB = entry("b1", conv: "b", at: 5)
  let noRouteC = entry("c1", conv: "c", route: false, at: 7)
  let tabs = [busyA, noRouteC, waitB]  // newest first
  check(conversationKey(waitB) == "agent\u{0}b", "tabs: a conversation key is source + conversation")
  check(TabSelection.newestWaiting(tabs) == conversationKey(waitB), "tabs: newest waiting with a route")
  check(TabSelection.resolve(selected: conversationKey(busyA), ordered: tabs) == conversationKey(busyA), "tabs: keep the selection")
  let replacedA = entry("a2", conv: "a", state: "waiting", at: 12)
  check(
    TabSelection.resolve(selected: conversationKey(busyA), ordered: [replacedA, noRouteC, waitB]) == conversationKey(replacedA),
    "tabs: a newer response keeps its conversation selected")
  check(TabSelection.resolve(selected: "gone", ordered: tabs) == conversationKey(waitB), "tabs: a gone selection falls back to newest waiting")
  check(TabSelection.resolve(selected: nil, ordered: [busyA, noRouteC]) == conversationKey(busyA), "tabs: no waiting falls back to the newest")
  check(TabSelection.resolve(selected: "x", ordered: []) == nil, "tabs: nothing to select")
  check(tabIndex(digit: 1, count: 3) == 0 && tabIndex(digit: 3, count: 3) == 2, "tabs: ⌘1 and ⌘3")
  check(tabIndex(digit: 4, count: 3) == nil && tabIndex(digit: 0, count: 3) == nil && tabIndex(digit: 10, count: 12) == nil, "tabs: out of range digits")
  check(cycledIndex(current: 2, count: 3, forward: true) == 0 && cycledIndex(current: 0, count: 3, forward: false) == 2, "tabs: ⌃⇥ wraps")
  check(cycledIndex(current: 0, count: 0, forward: true) == 0, "tabs: cycling with no tabs")
  check(TabDot.of(waitB) == .waiting && TabDot.of(busyA) == .working && TabDot.of(noRouteC) == .none, "dots: waiting, working, no route")
  check(TabDot.of(entry("s", conv: "s", state: "sending")) == .working && TabDot.of(entry("t", conv: "t", state: "typed")) == .typed, "dots: sending, typed")
  check(metaLine(entry("m", conv: "m", at: 0), now: 120_000) == "web · claude · 2m ago", "meta: label · agent · age")
  check(metaLine(entry("n", conv: "n", route: false, at: 0), now: 5_000) == "web · agent · 5s ago", "meta: no route shows the source")
  check(metaLine(entry("o", conv: "o", route: false, label: nil, at: 0), now: 5_000) == "agent · 5s ago", "meta: no label, no route: the source once")

  // Redesign: the view model (drafts, results and selection per conversation)
  let vm = InboxViewModel()
  let w1 = entry("w1", conv: "w", at: 3)
  let x1 = entry("x1", conv: "x", state: "busy", at: 4)
  vm.update([x1, w1])
  check(vm.selected == conversationKey(w1), "vm: selects the newest waiting at first")
  check(vm.waitingCount == 1, "vm: waiting count")
  vm.drafts[conversationKey(w1)] = "half typed"
  vm.update([x1, w1])
  check(vm.drafts[conversationKey(w1)] == "half typed", "vm: drafts survive an update")
  let w2 = entry("w2", conv: "w", at: 8)
  vm.update([w2, x1])
  check(vm.drafts[conversationKey(w2)] == "half typed", "vm: an unsent draft carries to a newer response")
  check(vm.results[conversationKey(w2)] == .refused(reason: "newer", error: ""), "vm: a carried draft says a newer response arrived")
  check(vm.selected == conversationKey(w2), "vm: the selection stays on the conversation")
  vm.began(conversationKey(w2))
  check(vm.inFlight.contains(conversationKey(w2)), "vm: in flight")
  vm.finished(conversationKey(w2), .typed, sent: "half typed")
  check(!vm.inFlight.contains(conversationKey(w2)) && vm.results[conversationKey(w2)] == .typed, "vm: typed result")
  let w3 = entry("w3", conv: "w", at: 12)
  vm.update([w3, x1])
  check(vm.drafts[conversationKey(w3)] == nil, "vm: text already delivered does not carry")
  check(vm.results[conversationKey(w3)] == nil, "vm: a newer response clears the old result")
  vm.drafts[conversationKey(w3)] = "go"
  vm.finished(conversationKey(w3), .submitted, sent: "go")
  check(vm.drafts[conversationKey(w3)] == nil || vm.drafts[conversationKey(w3)] == "", "vm: submitted clears the draft")
  vm.update([x1])
  check(vm.drafts[conversationKey(w3)] == nil && vm.selected == conversationKey(x1), "vm: a removed conversation drops its draft; selection moves")
  vm.update([entry("y1", conv: "y", at: 20), x1, entry("z1", conv: "z", at: 1)])
  vm.select(digit: 3)
  check(vm.selected == "agent\u{0}z", "vm: ⌘3 selects the third tab")
  vm.cycle(forward: true)
  check(vm.selected == "agent\u{0}y", "vm: ⌃⇥ wraps to the first tab")
  vm.select(digit: 9)
  check(vm.selected == "agent\u{0}y", "vm: a digit with no tab changes nothing")
  let before = vm.focusRequest
  vm.requestFocus()
  check(vm.focusRequest == before + 1, "vm: focus requests count up")

  // Review fixes: a pop-up never moves a key panel's selection; removal selects the tab in its place
  let pv = InboxViewModel()
  pv.update([entry("p1", conv: "p", at: 9), entry("q1", conv: "q", state: "busy", at: 5)])
  pv.selected = "agent\u{0}q"
  pv.selectForPopUp(panelIsKey: true)
  check(pv.selected == "agent\u{0}q", "vm: a pop-up while you type in the panel keeps your tab")
  pv.selectForPopUp(panelIsKey: false)
  check(pv.selected == "agent\u{0}p", "vm: a pop-up on a hidden or unfocused panel selects the newest waiting")
  let rv = InboxViewModel()
  let six = (1...6).map { entry("r\($0)", conv: "r\($0)", state: "busy", at: Double(10 - $0)) }
  rv.update(six)
  rv.selected = conversationKey(six[3])
  rv.update(six.filter { $0.id != "r4" })
  check(rv.selected == conversationKey(six[4]), "vm: removing a tab selects the one that takes its place")
  rv.selected = conversationKey(six[5])
  rv.update(six.filter { $0.id != "r4" && $0.id != "r6" })
  check(rv.selected == conversationKey(six[4]), "vm: removing the last tab selects the one above")

  // A long reply is cut to a preview until you expand it; a short one shows in full
  func reply(_ text: String) -> InboxEntry {
    InboxEntry(
      id: "s1", source: "agent", conversationId: "s", label: "web", text: text, summary: "Ignored.", at: 1,
      route: nil, state: "waiting")
  }
  check(messagePreview("Done.") == nil, "preview: a short reply needs none")
  let manyLines = (1...10).map { "Line \($0)." }.joined(separator: "\n")
  check(
    messagePreview(manyLines) == (1...previewLines).map { "Line \($0)." }.joined(separator: "\n") + "…",
    "preview: cut after \(previewLines) lines")
  let longLine = String(repeating: "word ", count: 200)
  let cut = messagePreview(longLine) ?? ""
  check(cut.count <= previewChars + 1 && cut.hasSuffix("word…"), "preview: a long line is cut at a word, got \(cut.suffix(12))")
  check(messagePreview("Line.\n\n\n") == nil, "preview: trailing blank lines don't count")
  check(
    messageDisplay(reply(manyLines), expanded: false).toggle == "Show full response"
      && messageDisplay(reply(manyLines), expanded: false).text == messagePreview(manyLines),
    "message: a long reply shows its preview, never the summary")
  check(
    messageDisplay(reply(manyLines), expanded: true) == MessageDisplay(text: manyLines, toggle: "Show less"),
    "message: expanded shows the full reply")
  check(messageDisplay(reply("Done."), expanded: false) == MessageDisplay(text: "Done.", toggle: nil), "message: short, no toggle")
  let ev = InboxViewModel()
  let e1 = entry("e1", conv: "e", at: 1)
  ev.update([e1])
  check(!ev.isExpanded(conversationKey(e1)), "vm: starts collapsed")
  ev.toggleExpanded(conversationKey(e1))
  check(ev.isExpanded(conversationKey(e1)), "vm: toggles to expanded")
  ev.update([entry("e2", conv: "e", at: 2)])
  check(!ev.isExpanded(conversationKey(e1)), "vm: a newer response starts collapsed")
  ev.toggleExpanded(conversationKey(e1))
  ev.update([])
  check(!ev.isExpanded(conversationKey(e1)), "vm: a removed conversation forgets it")

  if failures.isEmpty {
    print("ok")
    return 0
  }
  for f in failures { print("FAIL \(f)") }
  return 1
}
