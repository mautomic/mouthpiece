// MouthpieceHotkeys.swift: global hotkeys for Mouthpiece. Uses Carbon RegisterEventHotKey (no Accessibility permission).
// Usage: mouthpiece-hotkeys --url http://127.0.0.1:7317 --token-file ~/.mouthpiece/token --bind stop=ctrl+alt+s ...
// Exit 2: bad arguments or a hotkey that is already taken.
import AppKit
import Carbon.HIToolbox

struct Binding {
  let action: String
  let keyCode: UInt32
  let modifiers: UInt32
}

let keyCodes: [String: UInt32] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
  "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
  "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
]
let modifierMasks: [String: Int] = ["ctrl": controlKey, "alt": optionKey, "shift": shiftKey, "cmd": cmdKey]
let routes: [String: (path: String, body: String)] = [
  "stop": ("/v1/stop", "{}"),
  "skip": ("/v1/skip", "{}"),
  "replay": ("/v1/replay", "{}"),
  "toggleMode": ("/v1/mode", "{\"toggle\":true}"),
]

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("mouthpiece-hotkeys: \(message)\n".utf8))
  exit(2)
}

var baseURL = ""
var tokenFile = ""
var bindings: [Binding] = []

var argIterator = CommandLine.arguments.dropFirst().makeIterator()
while let arg = argIterator.next() {
  switch arg {
  case "--url":
    guard let value = argIterator.next() else { fail("--url needs a value") }
    baseURL = value
  case "--token-file":
    guard let value = argIterator.next() else { fail("--token-file needs a value") }
    tokenFile = value
  case "--bind":
    guard let spec = argIterator.next(), let eq = spec.firstIndex(of: "=") else { fail("--bind needs action=keys") }
    let action = String(spec[..<eq])
    guard routes[action] != nil else { fail("unknown action \(action)") }
    var parts = spec[spec.index(after: eq)...].lowercased().split(separator: "+").map(String.init)
    guard let key = parts.popLast(), let code = keyCodes[key] else { fail("unknown key in \(spec)") }
    var mask = 0
    for part in parts {
      guard let m = modifierMasks[part] else { fail("unknown modifier \(part)") }
      mask |= m
    }
    bindings.append(Binding(action: action, keyCode: code, modifiers: UInt32(mask)))
  default:
    fail("unknown argument \(arg)")
  }
}
if baseURL.isEmpty || tokenFile.isEmpty || bindings.isEmpty {
  fail("usage: mouthpiece-hotkeys --url URL --token-file PATH --bind action=mods+key ...")
}

func send(_ action: String) {
  guard let route = routes[action], let url = URL(string: baseURL + route.path) else { return }
  let token = (try? String(contentsOfFile: tokenFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.timeoutInterval = 2
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
  request.httpBody = Data(route.body.utf8)
  URLSession.shared.dataTask(with: request) { _, _, error in
    if let error {
      FileHandle.standardError.write(Data("mouthpiece-hotkeys: \(action) failed: \(error.localizedDescription)\n".utf8))
    }
  }.resume()
}

var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
  var hotKeyID = EventHotKeyID()
  GetEventParameter(
    event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
    nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
  let index = Int(hotKeyID.id)
  if index < bindings.count { send(bindings[index].action) }
  return noErr
}, 1, &eventSpec, nil, nil)

for (index, binding) in bindings.enumerated() {
  var ref: EventHotKeyRef?
  let id = EventHotKeyID(signature: OSType(0x4D50_4854), id: UInt32(index))  // 'MPHT'
  let status = RegisterEventHotKey(binding.keyCode, binding.modifiers, id, GetApplicationEventTarget(), 0, &ref)
  if status != noErr { fail("could not register \(binding.action) (status \(status)); is it used by another app?") }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
