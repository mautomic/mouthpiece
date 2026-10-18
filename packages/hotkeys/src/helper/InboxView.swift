// InboxView.swift: the inbox panel's SwiftUI views (US-026): the Conversation layout, with a
// native macOS look (system colours and font, light and dark).
import AppKit
import SwiftUI

struct InboxRootView: View {
  @ObservedObject var model: InboxViewModel

  var body: some View {
    VStack(spacing: 0) {
      header
      if model.ordered.isEmpty {
        Spacer()
        Text("Nothing yet").foregroundStyle(.secondary)
        Spacer()
      } else {
        TabStrip(model: model)
        Divider().opacity(0.5)
        if let entry = model.selectedEntry {
          ConversationView(model: model, entry: entry)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(shortcuts)
    .ignoresSafeArea(.container, edges: .top)  // the header shares the title bar with the traffic lights
    .onHover { inside in if inside { model.actions?.hovered() } }
    .onExitCommand { model.actions?.hide() }  // Esc outside the reply box hands the keyboard back too
  }

  private var header: some View {
    HStack(spacing: 8) {
      Spacer().frame(width: 64)  // the system traffic lights
      Text("Inbox").font(.system(size: 13, weight: .semibold))
      if model.waitingCount > 0 {
        Text("\(model.waitingCount)")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(.white)
          .padding(.horizontal, 7).padding(.vertical, 1)
          .background(Color.accentColor, in: Capsule())
      }
      Spacer()
      Menu {
        Button("Clear all") { model.actions?.clearAll() }
      } label: {
        Image(systemName: "ellipsis")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
    }
    .padding(.horizontal, 12)
    .frame(height: 28)  // the system title bar's height, so "Inbox" lines up with the traffic lights
  }

  /// ⌘1…⌘9 and ⌃⇥ / ⌃⇧⇥ while the reply box isn't taking them.
  private var shortcuts: some View {
    ZStack {
      ForEach(1...9, id: \.self) { digit in
        Button("") { model.select(digit: digit) }
          .keyboardShortcut(KeyEquivalent(Character("\(digit)")), modifiers: .command)
      }
      Button("") { model.cycle(forward: true) }.keyboardShortcut(.tab, modifiers: .control)
      Button("") { model.cycle(forward: false) }.keyboardShortcut(.tab, modifiers: [.control, .shift])
    }
    .opacity(0)
    .allowsHitTesting(false)
  }
}

struct TabStrip: View {
  @ObservedObject var model: InboxViewModel

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(model.ordered, id: \.id) { entry in
            TabChip(model: model, entry: entry).id(conversationKey(entry))
          }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
      }
      .onChange(of: model.selected) { _, key in
        if let key { withAnimation { proxy.scrollTo(key) } }
      }
    }
  }
}

struct TabChip: View {
  @ObservedObject var model: InboxViewModel
  let entry: InboxEntry
  @State private var hovering = false

  private var key: String { conversationKey(entry) }
  private var isSelected: Bool { model.selected == key }

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(dotColor(TabDot.of(entry))).frame(width: 6, height: 6)
      Text(entry.name).font(.system(size: 12)).lineLimit(1)
      if hovering {
        Button {
          model.actions?.dismiss(entry)
        } label: {
          Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("Remove from the inbox")
      }
    }
    .padding(.leading, 10).padding(.trailing, hovering ? 6 : 10).padding(.vertical, 4)
    .background(isSelected ? Color.primary.opacity(0.12) : Color.clear, in: Capsule())
    .opacity(isSelected ? 1 : 0.75)
    .contentShape(Capsule())
    .onTapGesture { model.selected = key }
    .onHover { hovering = $0 }
  }
}

func dotColor(_ dot: TabDot) -> Color {
  switch dot {
  case .waiting: return .orange
  case .working: return .accentColor
  case .typed: return .yellow
  case .none: return .gray
  }
}

/// Inline markdown (bold, italic, `code`, links), keeping line breaks; anything else as plain text.
func markdown(_ text: String) -> AttributedString {
  let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
  return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
}

struct ConversationView: View {
  @ObservedObject var model: InboxViewModel
  let entry: InboxEntry

  private var key: String { conversationKey(entry) }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 6) {
          TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(metaLine(entry, now: context.date.timeIntervalSince1970 * 1000))
              .font(.system(size: 11)).foregroundStyle(.secondary)
          }
          Text(markdown(entry.text))
            .font(.system(size: 13)).lineSpacing(2)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 6)
      }
      .id(entry.id)  // a new tab or response opens at the top
      ResultLine(model: model, entry: entry)
      if entry.route == nil {
        Text("Can't reply here.")
          .font(.system(size: 12)).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
          .padding(10)
      } else {
        ComposerView(model: model, entry: entry).id(key)
      }
    }
  }
}

struct ResultLine: View {
  @ObservedObject var model: InboxViewModel
  let entry: InboxEntry

  var body: some View {
    let outcome = model.results[conversationKey(entry)]
    if outcome != nil || entry.state == "typed" {
      HStack(spacing: 8) {
        if let outcome {
          Text(RowText.result(outcome)).foregroundStyle(color(outcome))
        } else {
          Text("Typed, not submitted.").foregroundStyle(.yellow)
        }
        if entry.state == "typed" && entry.route != nil {
          Button("Submit") { model.actions?.submit(entry) }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(model.inFlight.contains(conversationKey(entry)))
        }
        Spacer()
      }
      .font(.system(size: 11.5))
      .padding(.horizontal, 14).padding(.top, 2)
    }
  }

  private func color(_ outcome: ReplyOutcome) -> Color {
    switch outcome {
    case .submitted: return .green
    case .typed: return .yellow
    case .refused: return .secondary
    }
  }
}

struct ComposerView: View {
  @ObservedObject var model: InboxViewModel
  let entry: InboxEntry
  @State private var height: CGFloat = 17

  private var key: String { conversationKey(entry) }
  private var sending: Bool { model.inFlight.contains(key) }
  private var enabled: Bool { entry.state == "waiting" && !sending }
  private var text: SwiftUI.Binding<String> {
    SwiftUI.Binding(get: { model.drafts[key] ?? "" }, set: { model.drafts[key] = $0 })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack(alignment: .topLeading) {
        if text.wrappedValue.isEmpty {
          HStack(spacing: 6) {
            if entry.state == "busy" { ProgressView().controlSize(.mini) }
            Text(enabled ? "Reply to \(entry.name)…" : RowText.placeholder(entry, sending: sending))
          }
          .font(.system(size: 13)).foregroundStyle(.tertiary)
          .allowsHitTesting(false)
        }
        ReplyEditor(
          text: text, height: $height, enabled: enabled, focusRequest: model.focusRequest,
          onSend: send, onRemove: { model.actions?.dismiss(entry) },
          onEscape: { model.actions?.hide() }, onCycle: { model.cycle(forward: $0) }
        )
        .frame(height: height)
      }
      HStack {
        Text("⌘↩ send · ⌘⌫ remove").font(.system(size: 11)).foregroundStyle(.tertiary)
        Spacer()
        Button(action: send) {
          Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold))
            .frame(width: 24, height: 24)
            .background(enabled ? Color.accentColor : Color.secondary.opacity(0.4), in: Circle())
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .help("Send (⌘↩)")
      }
    }
    .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 8)
    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
    .opacity(enabled ? 1 : 0.6)
    .padding(10)
  }

  private func send() {
    let reply = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard enabled, !reply.isEmpty else { return }
    model.actions?.send(entry, reply)
  }
}

/// The reply box: an NSTextView, because its delegate sees ⌘↩ before a newline goes in. That's the
/// check part 2 proved in a panel that doesn't take focus. ↩ adds a line. It grows from 1 line to 5.
struct ReplyEditor: NSViewRepresentable {
  @SwiftUI.Binding var text: String
  @SwiftUI.Binding var height: CGFloat
  var enabled: Bool
  var focusRequest: Int
  var onSend: () -> Void
  var onRemove: () -> Void
  var onEscape: () -> Void
  var onCycle: (Bool) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSTextView.scrollableTextView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    let view = scroll.documentView as! NSTextView
    view.delegate = context.coordinator
    view.font = .systemFont(ofSize: 13)
    view.isRichText = false
    view.allowsUndo = true
    view.drawsBackground = false
    view.textContainerInset = .zero
    view.textContainer?.lineFragmentPadding = 0
    view.isAutomaticQuoteSubstitutionEnabled = false
    view.isAutomaticDashSubstitutionEnabled = false
    // -1: a new editor (tab switch, ⌃⌥I picking a tab) takes the cursor if the panel is key.
    context.coordinator.lastFocus = -1
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let view = scroll.documentView as? NSTextView else { return }
    // Only when it differs: typing updates the binding first, so a re-render never moves the caret.
    if view.string != text { view.string = text }
    view.isEditable = enabled
    view.textColor = enabled ? .labelColor : .secondaryLabelColor
    if context.coordinator.lastFocus != focusRequest {
      context.coordinator.lastFocus = focusRequest
      // Only in a key panel (⌃⌥I or the menubar): a pop-up is never key, so it never takes focus.
      DispatchQueue.main.async {
        if view.window?.isKeyWindow == true { view.window?.makeFirstResponder(view) }
      }
    }
    context.coordinator.measure(view)
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: ReplyEditor
    var lastFocus = 0

    init(_ parent: ReplyEditor) { self.parent = parent }

    func textDidChange(_ notification: Notification) {
      guard let view = notification.object as? NSTextView else { return }
      parent.text = view.string
      measure(view)
    }

    func measure(_ view: NSTextView) {
      guard let layout = view.layoutManager, let container = view.textContainer else { return }
      layout.ensureLayout(for: container)
      let line = layout.defaultLineHeight(for: view.font ?? .systemFont(ofSize: 13))
      let wanted = min(max(layout.usedRect(for: container).height, line), line * 5)
      if abs(parent.height - wanted) > 0.5 {
        let binding = parent.$height
        DispatchQueue.main.async { binding.wrappedValue = wanted }
      }
    }

    /// ⌘↩ sends; ⌘⌫ on an empty reply removes the tab; ⌃⇥ cycles tabs; Esc hides. Plain ↩ adds a line.
    func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
      if let event = NSApp.currentEvent, event.type == .keyDown {
        let flags = event.modifierFlags
        if flags.contains(.command), event.keyCode == 36 || event.keyCode == 76 {
          parent.onSend()
          return true
        }
        if flags.contains(.command), event.keyCode == 51, view.string.isEmpty {
          parent.onRemove()
          return true
        }
        if flags.contains(.control), event.keyCode == 48 {
          parent.onCycle(!flags.contains(.shift))
          return true
        }
      }
      if selector == #selector(NSResponder.cancelOperation(_:)) {
        parent.onEscape()
        return true
      }
      return false
    }
  }
}
