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

  var name: String { label ?? source }
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
  private var seen = Set<String>()
  private var started = false

  /// Applies one stream event. Returns the entries that are new: an id not seen before, arriving
  /// after the first snapshot. A snapshot (start-up or reconnect) is never new.
  func apply(event: String, data: String) -> [InboxEntry] {
    let bytes = Data(data.utf8)
    let decoder = JSONDecoder()
    switch event {
    case "snapshot":
      guard let snapshot = try? decoder.decode(InboxSnapshot.self, from: bytes) else { return [] }
      enabled = snapshot.enabled
      entries = Dictionary(snapshot.entries.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
      seen.formUnion(entries.keys)
      started = true
      return []
    case "entry":
      guard let entry = try? decoder.decode(InboxEntry.self, from: bytes) else { return [] }
      // A newer response replaces its conversation's row (the daemon sends no remove for it).
      entries = entries.filter {
        $0.key == entry.id || $0.value.source != entry.source || $0.value.conversationId != entry.conversationId
      }
      entries[entry.id] = entry
      let isNew = started && !seen.contains(entry.id)
      seen.insert(entry.id)
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
  var ordered: [InboxEntry] { entries.values.sorted { $0.at > $1.at } }

  /// Entries waiting for a reply that can be sent from here.
  var waitingCount: Int { entries.values.filter { $0.state == "waiting" && $0.route != nil }.count }
}

// MARK: - Pop-up policy ([reply] popup)

enum PopupMode: String {
  case away, always, never
}

/// Terminal host (a route's `via`) → its app's bundle id, for "away".
let hostBundleIds: [String: String] = ["orca": "com.stablyai.orca"]

/// Whether a new entry pops the panel up. Only waiting entries with a route ever do.
func shouldPop(_ entry: InboxEntry, mode: PopupMode, frontmost: String?) -> Bool {
  guard entry.state == "waiting", let route = entry.route else { return false }
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

// MARK: - Self-test (--self-test-inbox)

/// Checks the inbox logic offline. Prints "ok" and returns 0, or one "FAIL <case>" line per failure and 1.
func runInboxSelfTest() -> Int32 {
  var failures: [String] = []
  func check(_ ok: Bool, _ name: String) { if !ok { failures.append(name) } }

  func entryJSON(
    _ id: String, conv: String = "c1", state: String = "waiting", route: Bool = true, at: Double = 1,
    label: String? = "web"
  ) -> String {
    let r = route ? ",\"route\":{\"via\":\"orca\",\"target\":\"term_a\",\"agent\":\"claude\"}" : ""
    let l = label.map { ",\"label\":\"\($0)\"" } ?? ""
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

  if failures.isEmpty {
    print("ok")
    return 0
  }
  for f in failures { print("FAIL \(f)") }
  return 1
}
