// MouthpieceHelper.swift: the Mouthpiece helper app (MouthpieceHelper.app, LSUIElement).
//   --bind        global hotkeys via Carbon RegisterEventHotKey (no Accessibility permission)
//   --menubar     NSStatusItem that polls GET /v1/status (US-018)
//   --mic-pause   CoreAudio mic-in-use watcher that posts /v1/pause and /v1/resume, reason "mic" (US-022)
// Usage: mouthpiece-helper --url http://127.0.0.1:7317 --token-file ~/.mouthpiece/token
//          [--bind stop=ctrl+alt+s ...] [--menubar]
//          [--mic-pause [--mic-ignore <bundleId> ...] [--mic-resume-delay <ms>]]
// At least one of --bind, --menubar, --mic-pause is required.
// Exit 2: bad arguments or a hotkey that is already taken.
// The token is re-read from --token-file for every request and is never logged.
import AppKit
import Carbon.HIToolbox
import CoreAudio

// MARK: - Arguments

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

func log(_ message: String) {
  FileHandle.standardError.write(Data("mouthpiece-helper: \(message)\n".utf8))
}

func fail(_ message: String) -> Never {
  log(message)
  exit(2)
}

var baseURL = ""
var tokenFile = ""
var bindings: [Binding] = []
var menubarEnabled = false
var micPauseEnabled = false
var micIgnore: [String] = []
var micResumeDelayMs = 800

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
  case "--menubar":
    menubarEnabled = true
  case "--mic-pause":
    micPauseEnabled = true
  case "--mic-ignore":
    guard let value = argIterator.next(), !value.isEmpty else { fail("--mic-ignore needs a bundle id") }
    micIgnore.append(value)
  case "--mic-resume-delay":
    guard let value = argIterator.next(), let ms = Int(value), ms > 0 else {
      fail("--mic-resume-delay needs a positive number of milliseconds")
    }
    micResumeDelayMs = ms
  default:
    fail("unknown argument \(arg)")
  }
}
if baseURL.isEmpty || tokenFile.isEmpty {
  fail("usage: mouthpiece-helper --url URL --token-file PATH [--bind action=mods+key ...] [--menubar] [--mic-pause]")
}
if bindings.isEmpty && !menubarEnabled && !micPauseEnabled {
  fail("nothing to do: pass at least one of --bind, --menubar, --mic-pause")
}

// MARK: - Daemon client

let session: URLSession = {
  let config = URLSessionConfiguration.ephemeral
  config.timeoutIntervalForRequest = 2
  config.requestCachePolicy = .reloadIgnoringLocalCacheData
  config.urlCache = nil
  config.httpCookieStorage = nil
  return URLSession(configuration: config)
}()

/// Read on every request so a rotated token is picked up. Never logged.
func readToken() -> String {
  (try? String(contentsOfFile: tokenFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

/// Calls the daemon; `done` runs on the main queue with the body on a 2xx response, nil otherwise.
func callDaemon(
  _ method: String, _ path: String, body: String? = nil, timeout: TimeInterval = 2,
  done: ((Data?) -> Void)? = nil
) {
  guard let url = URL(string: baseURL + path) else {
    done?(nil)
    return
  }
  var request = URLRequest(url: url)
  request.httpMethod = method
  request.timeoutInterval = timeout
  request.setValue("Bearer \(readToken())", forHTTPHeaderField: "Authorization")
  if let body {
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(body.utf8)
  }
  session.dataTask(with: request) { data, response, error in
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let ok = error == nil && (200..<300).contains(status)
    if method != "GET" && !ok {
      // Polls report failures themselves; only the method and path are logged, never headers.
      log("\(method) \(path) failed: \(error?.localizedDescription ?? "HTTP \(status)")")
    }
    DispatchQueue.main.async { done?(ok ? (data ?? Data()) : nil) }
  }.resume()
}

func post(_ path: String, _ body: String, done: ((Data?) -> Void)? = nil) {
  callDaemon("POST", path, body: body, done: done)
}

// MARK: - Hotkeys

func sendHotkey(_ action: String) {
  guard let route = routes[action] else { return }
  post(route.path, route.body)
}

if !bindings.isEmpty {
  var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
  InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
    var hotKeyID = EventHotKeyID()
    GetEventParameter(
      event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
      nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
    let index = Int(hotKeyID.id)
    if index < bindings.count { sendHotkey(bindings[index].action) }
    return noErr
  }, 1, &eventSpec, nil, nil)

  for (index, binding) in bindings.enumerated() {
    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: OSType(0x4D50_4854), id: UInt32(index))  // 'MPHT'
    let status = RegisterEventHotKey(binding.keyCode, binding.modifiers, id, GetApplicationEventTarget(), 0, &ref)
    if status != noErr { fail("could not register \(binding.action) (status \(status)); is it used by another app?") }
  }
}

// MARK: - Menubar

struct DaemonStatus: Decodable {
  struct Current: Decodable {
    let source: String
    let label: String?
  }
  let version: String
  let speaking: Bool
  let paused: Bool
  let pauseReasons: [String]
  let mode: String
  let queueDepth: Int
  let provider: String
  let current: Current?
}

/// Polls GET /v1/status every second (one request in flight at most, 1 s timeout).
/// After 3 consecutive failures it shows "daemon down" and polls every 5 s until the daemon answers.
final class Menubar: NSObject {
  static let fastInterval: TimeInterval = 1
  static let slowInterval: TimeInterval = 5
  static let failuresBeforeBackoff = 3

  let item: NSStatusItem
  let menu = NSMenu()
  let infoItem = NSMenuItem(title: "Mouthpiece", action: nil, keyEquivalent: "")
  let pauseItem = NSMenuItem(title: "Pause speech", action: nil, keyEquivalent: "")
  var actionItems: [NSMenuItem] = []
  var modeItems: [String: NSMenuItem] = [:]
  var status: DaemonStatus?
  var failures = 0
  var inFlight = false
  var timer: Timer?

  override init() {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    super.init()
    menu.autoenablesItems = false
    addAction("Stop", "/v1/stop", "{}")
    addAction("Skip", "/v1/skip", "{}")
    addAction("Replay", "/v1/replay", "{}")
    addAction("Replay full", "/v1/replay", "{\"full\":true}")

    let modeMenu = NSMenu()
    modeMenu.autoenablesItems = false
    for (title, mode) in [("Summary", "summary"), ("Full", "full"), ("Off", "off")] {
      let entry = routeItem(title, "/v1/mode", "{\"mode\":\"\(mode)\"}")
      modeMenu.addItem(entry)
      modeItems[mode] = entry
    }
    let modeItem = NSMenuItem(title: "Mode", action: nil, keyEquivalent: "")
    modeItem.submenu = modeMenu
    menu.addItem(modeItem)
    actionItems.append(modeItem)

    pauseItem.target = self
    pauseItem.action = #selector(togglePause(_:))
    menu.addItem(pauseItem)
    actionItems.append(pauseItem)

    menu.addItem(NSMenuItem.separator())
    infoItem.isEnabled = false
    menu.addItem(infoItem)

    item.menu = menu
    item.button?.imagePosition = .imageLeading
    render()
    poll()
  }

  /// A menu item that posts `body` to `path` when chosen.
  func routeItem(_ title: String, _ path: String, _ body: String) -> NSMenuItem {
    let entry = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: "")
    entry.target = self
    entry.representedObject = [path, body]
    return entry
  }

  func addAction(_ title: String, _ path: String, _ body: String) {
    let entry = routeItem(title, path, body)
    menu.addItem(entry)
    actionItems.append(entry)
  }

  @objc func menuAction(_ sender: NSMenuItem) {
    guard let route = sender.representedObject as? [String], route.count == 2 else { return }
    post(route[0], route[1]) { [weak self] _ in self?.pollSoon() }
  }

  @objc func togglePause(_ sender: NSMenuItem) {
    post(userPaused ? "/v1/resume" : "/v1/pause", "{\"reason\":\"user\"}") { [weak self] _ in self?.pollSoon() }
  }

  var reachable: Bool { status != nil }
  var userPaused: Bool { status?.pauseReasons.contains("user") ?? false }

  func poll() {
    guard !inFlight else { return }
    timer = nil
    inFlight = true
    callDaemon("GET", "/v1/status", timeout: Menubar.fastInterval) { [weak self] data in
      guard let self else { return }
      self.inFlight = false
      if let data, let next = try? JSONDecoder().decode(DaemonStatus.self, from: data) {
        if self.failures >= Menubar.failuresBeforeBackoff { log("daemon reachable") }
        self.failures = 0
        self.status = next
      } else {
        self.failures += 1
        if self.failures == Menubar.failuresBeforeBackoff {
          log("daemon unreachable; polling every \(Int(Menubar.slowInterval)) s")
          self.status = nil
        }
      }
      self.render()
      self.schedule(
        self.failures >= Menubar.failuresBeforeBackoff ? Menubar.slowInterval : Menubar.fastInterval)
    }
  }

  func schedule(_ interval: TimeInterval) {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in self?.poll() }
  }

  /// Refresh right after a menu action, without overlapping an in-flight poll.
  func pollSoon() {
    guard !inFlight else { return }
    timer?.invalidate()
    poll()
  }

  func render() {
    let symbol: String
    let description: String
    if let s = status {
      if s.paused {
        (symbol, description) = ("pause.circle", "Mouthpiece paused")
      } else if s.speaking {
        (symbol, description) = ("speaker.wave.2.fill", "Mouthpiece speaking")
      } else {
        (symbol, description) = ("waveform", "Mouthpiece idle")
      }
    } else {
      (symbol, description) = ("waveform.slash", "Mouthpiece daemon not running")
    }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
    image?.isTemplate = true
    item.button?.image = image
    item.button?.toolTip = description
    let depth = status?.queueDepth ?? 0
    item.button?.title = depth > 0 ? " \(depth)" : ""

    for entry in actionItems { entry.isEnabled = reachable }
    for (mode, entry) in modeItems {
      entry.isEnabled = reachable
      entry.state = status?.mode == mode ? .on : .off
    }
    pauseItem.title = userPaused ? "Resume speech" : "Pause speech"
    if let s = status {
      infoItem.title = "Mouthpiece \(s.version) · \(s.provider)"
    } else {
      infoItem.title = "Mouthpiece daemon not running"
    }
  }
}

// MARK: - Mic watcher

func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readScalar<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var address = propertyAddress(selector)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  let status = withUnsafeMutablePointer(to: &value) {
    AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
  }
  return status == noErr ? value : nil
}

func readObjectList(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID]? {
  var address = propertyAddress(selector)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr else { return nil }
  let stride = MemoryLayout<AudioObjectID>.stride
  var ids = [AudioObjectID](repeating: kAudioObjectUnknown, count: Int(size) / stride)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &ids) == noErr else { return nil }
  return Array(ids.prefix(Int(size) / stride))
}

func readCFString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = propertyAddress(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  let status = withUnsafeMutablePointer(to: &value) {
    AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
  }
  guard status == noErr, let value else { return nil }
  return value.takeRetainedValue() as String
}

/// Watches whether another app is capturing audio. Notifications can be spurious, so every one triggers a
/// full re-query. Mic active: pause at once. Mic idle: wait the resume delay, re-check, then resume.
final class MicWatcher {
  let ignore: [String]
  let resumeDelay: TimeInterval
  let excludedPIDs: Set<pid_t> = [getpid(), getppid()]
  let system = AudioObjectID(kAudioObjectSystemObject)

  /// What the daemon was last told: true after pause, false after resume.
  var active = false
  var resumeWork: DispatchWorkItem?
  var recheckTimer: Timer?
  var deviceListener: (device: AudioObjectID, block: AudioObjectPropertyListenerBlock)?
  var processListeners: [AudioObjectID: AudioObjectPropertyListenerBlock] = [:]
  var perProcess = false

  init(ignore: [String], resumeDelayMs: Int) {
    self.ignore = ignore
    self.resumeDelay = TimeInterval(resumeDelayMs) / 1000
    if #available(macOS 14.0, *) {
      perProcess = readObjectList(system, kAudioHardwarePropertyProcessObjectList) != nil
    }
    log("mic watcher: \(perProcess ? "per-process" : "device-level fallback")")

    listen(system, kAudioHardwarePropertyDefaultInputDevice) { [weak self] in
      self?.watchDefaultInputDevice()
      self?.evaluate()
    }
    watchDefaultInputDevice()
    if perProcess, #available(macOS 14.0, *) {
      listen(system, kAudioHardwarePropertyProcessObjectList) { [weak self] in
        self?.watchProcesses()
        self?.evaluate()
      }
      watchProcesses()
    }
    // Clear a stale "mic" reason from an earlier helper run; resume is idempotent in the daemon.
    if micUser() == nil { sync(active: false, attempt: 0) }
    evaluate()
  }

  @discardableResult
  func listen(
    _ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ handler: @escaping () -> Void
  ) -> AudioObjectPropertyListenerBlock? {
    var address = propertyAddress(selector)
    let block: AudioObjectPropertyListenerBlock = { _, _ in handler() }
    let status = AudioObjectAddPropertyListenerBlock(object, &address, DispatchQueue.main, block)
    return status == noErr ? block : nil
  }

  func unlisten(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ block: @escaping AudioObjectPropertyListenerBlock) {
    var address = propertyAddress(selector)
    _ = AudioObjectRemovePropertyListenerBlock(object, &address, DispatchQueue.main, block)
  }

  func defaultInputDevice() -> AudioObjectID? {
    guard let device = readScalar(system, kAudioHardwarePropertyDefaultInputDevice, AudioObjectID(kAudioObjectUnknown)),
      device != kAudioObjectUnknown
    else { return nil }
    return device
  }

  /// Follow the default input device's running state (a trigger in per-process mode, the signal otherwise).
  func watchDefaultInputDevice() {
    let device = defaultInputDevice()
    if deviceListener?.device == device { return }
    if let old = deviceListener {
      unlisten(old.device, kAudioDevicePropertyDeviceIsRunningSomewhere, old.block)
      deviceListener = nil
    }
    guard let device else { return }
    if let block = listen(device, kAudioDevicePropertyDeviceIsRunningSomewhere, { [weak self] in self?.evaluate() }) {
      deviceListener = (device, block)
    }
  }

  /// Keep one IsRunningInput listener per audio process object.
  @available(macOS 14.0, *)
  func watchProcesses() {
    let current = Set(readObjectList(system, kAudioHardwarePropertyProcessObjectList) ?? [])
    for (object, block) in processListeners where !current.contains(object) {
      unlisten(object, kAudioProcessPropertyIsRunningInput, block)
      processListeners[object] = nil
    }
    for object in current where processListeners[object] == nil {
      if let block = listen(object, kAudioProcessPropertyIsRunningInput, { [weak self] in self?.evaluate() }) {
        processListeners[object] = block
      }
    }
  }

  func ignored(_ bundleID: String) -> Bool {
    ignore.contains { bundleID == $0 || bundleID.hasPrefix($0 + ".") }
  }

  /// Who is using the mic (for the log), or nil when nobody relevant is.
  func micUser() -> String? {
    if perProcess, #available(macOS 14.0, *),
      let processes = readObjectList(system, kAudioHardwarePropertyProcessObjectList)
    {
      for object in processes {
        guard readScalar(object, kAudioProcessPropertyIsRunningInput, UInt32(0)) == 1 else { continue }
        let pid = readScalar(object, kAudioProcessPropertyPID, pid_t(-1)) ?? -1
        if excludedPIDs.contains(pid) { continue }
        let bundleID = readCFString(object, kAudioProcessPropertyBundleID) ?? ""
        if !bundleID.isEmpty && ignored(bundleID) { continue }
        return bundleID.isEmpty ? "pid \(pid)" : bundleID
      }
      return nil
    }
    guard let device = defaultInputDevice(),
      readScalar(device, kAudioDevicePropertyDeviceIsRunningSomewhere, UInt32(0)) == 1
    else { return nil }
    return "input device"
  }

  func evaluate() {
    if let user = micUser() {
      resumeWork?.cancel()
      resumeWork = nil
      guard !active else { return }
      active = true
      log("mic in use (\(user)); pausing speech")
      sync(active: true, attempt: 0)
      startRecheck()
    } else if active && resumeWork == nil {
      let work = DispatchWorkItem { [weak self] in
        guard let self else { return }
        self.resumeWork = nil
        guard self.micUser() == nil, self.active else { return }
        self.active = false
        self.stopRecheck()
        log("mic idle; resuming speech")
        self.sync(active: false, attempt: 0)
      }
      resumeWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + resumeDelay, execute: work)
    }
  }

  /// While paused, re-check every 2 s in case an idle notification never arrives (no CPU cost when idle).
  func startRecheck() {
    recheckTimer?.invalidate()
    recheckTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.evaluate() }
  }

  func stopRecheck() {
    recheckTimer?.invalidate()
    recheckTimer = nil
  }

  /// Tell the daemon; retry a few times (2 s apart) while the state is unchanged.
  func sync(active wanted: Bool, attempt: Int) {
    post(wanted ? "/v1/pause" : "/v1/resume", "{\"reason\":\"mic\"}") { [weak self] data in
      guard let self, data == nil, self.active == wanted else { return }
      if attempt >= 3 {
        log("mic \(wanted ? "pause" : "resume") not delivered; daemon unreachable")
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
        guard let self, self.active == wanted else { return }
        self.sync(active: wanted, attempt: attempt + 1)
      }
    }
  }
}

// MARK: - Run

let app = NSApplication.shared
// .accessory, not .prohibited: a status item needs a window server connection. LSUIElement hides the Dock icon.
app.setActivationPolicy(.accessory)
let menubar = menubarEnabled ? Menubar() : nil
let micWatcher = micPauseEnabled ? MicWatcher(ignore: micIgnore, resumeDelayMs: micResumeDelayMs) : nil
app.run()
