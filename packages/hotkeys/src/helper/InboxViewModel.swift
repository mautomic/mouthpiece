// InboxViewModel.swift: the inbox panel's state (US-026): entries, the selected tab, and the
// drafts, results and in-flight replies per conversation. No AppKit, so the self-test checks it.
import Combine
import Foundation

/// What the views ask the panel to do.
struct InboxActions {
  var send: (InboxEntry, String) -> Void
  var submit: (InboxEntry) -> Void
  var dismiss: (InboxEntry) -> Void
  var clearAll: () -> Void
  var hide: () -> Void
  var hovered: () -> Void
}

final class InboxViewModel: ObservableObject {
  @Published private(set) var ordered: [InboxEntry] = []
  /// The selected tab: a conversation key, so a newer response keeps it.
  @Published var selected: String?
  /// The reply box's text, per conversation.
  @Published var drafts: [String: String] = [:]
  /// The result line under the message, per conversation.
  @Published private(set) var results: [String: ReplyOutcome] = [:]
  @Published private(set) var inFlight: Set<String> = []
  /// Bumped to move the cursor into the reply box (the hotkey or menubar path only).
  @Published private(set) var focusRequest = 0
  var actions: InboxActions?
  /// The text last delivered from each conversation (typed or submitted), never carried over again.
  private var lastSent: [String: String] = [:]
  /// The entry id last seen per conversation, to notice a newer response.
  private var entryIds: [String: String] = [:]

  var selectedEntry: InboxEntry? { ordered.first { conversationKey($0) == selected } }

  var waitingCount: Int { ordered.filter { $0.state == "waiting" && $0.route != nil }.count }

  /// New entries from the stream. A newer response for a conversation clears its old result, and
  /// keeps its draft unless that is the text already delivered (then a notice says it's newer).
  func update(_ entries: [InboxEntry]) {
    var keys = Set<String>()
    for entry in entries {
      let key = conversationKey(entry)
      keys.insert(key)
      if let previous = entryIds[key], previous != entry.id {
        results[key] = nil
        if let draft = drafts[key] {
          if carriedDraft(text: draft, lastSent: lastSent[key]) != nil {
            results[key] = .refused(reason: "newer", error: "")
          } else {
            drafts[key] = nil
          }
        }
      }
      entryIds[key] = entry.id
    }
    for key in Set(entryIds.keys).subtracting(keys) {
      entryIds[key] = nil
      drafts[key] = nil
      results[key] = nil
      lastSent[key] = nil
      inFlight.remove(key)
    }
    ordered = entries
    selected = TabSelection.resolve(selected: selected, ordered: entries)
  }

  func selectNewestWaiting() {
    if let key = TabSelection.newestWaiting(ordered) { selected = key }
  }

  func select(digit: Int) {
    if let index = tabIndex(digit: digit, count: ordered.count) { selected = conversationKey(ordered[index]) }
  }

  func cycle(forward: Bool) {
    guard !ordered.isEmpty else { return }
    let current = ordered.firstIndex { conversationKey($0) == selected } ?? 0
    selected = conversationKey(ordered[cycledIndex(current: current, count: ordered.count, forward: forward)])
  }

  func requestFocus() { focusRequest += 1 }

  func began(_ key: String) { inFlight.insert(key) }

  func finished(_ key: String, _ outcome: ReplyOutcome, sent text: String?) {
    inFlight.remove(key)
    results[key] = outcome
    if outcome == .submitted || outcome == .typed, let text { lastSent[key] = text }
    if outcome == .submitted { drafts[key] = "" }
  }

  func show(_ key: String, _ outcome: ReplyOutcome) { results[key] = outcome }
}
