// MouthpieceListen.swift: conversation-mode spike (PRD §12). On-device speech to text, nothing more.
// Captures the default mic with AVAudioEngine, transcribes with SFSpeechRecognizer
// (requiresOnDeviceRecognition), and ends an utterance after 1.2 s with no new words.
// Each utterance becomes one JSON line, {"final":true,"text":"..."}, on stdout, or is POSTed to --post.
//
// Usage: mouthpiece-listen [--post <url>] [--token-file <path>] [--locale en-US] [--silence-ms 1200]
// Run it from its ad-hoc signed .app (open -n MouthpieceListen.app --args ...): the mic and speech
// permissions are charged to the responsible process, and without NSMicrophoneUsageDescription and
// NSSpeechRecognitionUsageDescription in that process's Info.plist macOS kills it.
// Exit 1: unavailable recognizer, denied permission, no input device. Exit 2: bad arguments.
import AVFoundation
import Foundation
import Speech

func log(_ message: String) {
  FileHandle.standardError.write(Data("mouthpiece-listen: \(message)\n".utf8))
}

func fail(_ message: String, code: Int32 = 1) -> Never {
  log(message)
  exit(code)
}

struct Options {
  var postURL: URL?
  var tokenFile: String?
  var localeID = "en-US"
  var silence: TimeInterval = 1.2
}

func parseOptions(_ args: [String]) -> Options {
  var options = Options()
  var iterator = args.makeIterator()
  func value(_ flag: String) -> String {
    guard let next = iterator.next() else { fail("\(flag) needs a value", code: 2) }
    return next
  }
  while let arg = iterator.next() {
    switch arg {
    case "--post":
      let raw = value(arg)
      guard let url = URL(string: raw), url.scheme == "http" || url.scheme == "https" else {
        fail("--post needs an http(s) URL", code: 2)
      }
      options.postURL = url
    case "--token-file":
      options.tokenFile = (value(arg) as NSString).expandingTildeInPath
    case "--locale":
      options.localeID = value(arg)
    case "--silence-ms":
      guard let ms = Double(value(arg)), ms >= 200, ms <= 10_000 else {
        fail("--silence-ms must be between 200 and 10000", code: 2)
      }
      options.silence = ms / 1000
    case "-h", "--help":
      print("usage: mouthpiece-listen [--post <url>] [--token-file <path>] [--locale en-US] [--silence-ms 1200]")
      exit(0)
    default:
      // Launch Services may still pass a process serial number on older systems.
      if arg.hasPrefix("-psn_") { continue }
      fail("unknown argument \(arg)", code: 2)
    }
  }
  return options
}

/// Writes one JSON line per utterance to stdout, or POSTs it.
final class Emitter {
  let postURL: URL?
  let tokenFile: String?

  init(postURL: URL?, tokenFile: String?) {
    self.postURL = postURL
    self.tokenFile = tokenFile
  }

  func emit(_ text: String) {
    guard
      let body = try? JSONSerialization.data(
        withJSONObject: ["text": text, "final": true], options: [.sortedKeys, .withoutEscapingSlashes])
    else { return }
    guard let url = postURL else {
      FileHandle.standardOutput.write(body + Data("\n".utf8))
      return
    }
    var request = URLRequest(url: url, timeoutInterval: 5)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    // Re-read on every post so a rotated token works; never log it.
    if let path = tokenFile,
      let token = try? String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
      !token.isEmpty
    {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    request.httpBody = body
    URLSession.shared.dataTask(with: request) { _, response, error in
      if let error {
        log("post failed: \(error.localizedDescription)")
      } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
        log("post failed: HTTP \(http.statusCode)")
      }
    }.resume()
  }
}

/// One recognition request. Audio keeps flowing into a fresh one while the last one finalizes.
final class Utterance {
  let request = SFSpeechAudioBufferRecognitionRequest()
  let started = Date()
  var task: SFSpeechRecognitionTask?
  var text = ""
  var delivered = false
}

/// All state lives on the main queue (SFSpeechRecognizer delivers results on OperationQueue.main by
/// default). Only the audio tap runs elsewhere, and it reads `current` under `lock`.
final class Listener {
  private let recognizer: SFSpeechRecognizer
  private let engine = AVAudioEngine()
  private let emitter: Emitter
  private let silence: TimeInterval
  private let lock = NSLock()
  private var current: Utterance?
  private var endpointWork: DispatchWorkItem?
  private var fastFailures = 0

  init(recognizer: SFSpeechRecognizer, emitter: Emitter, silence: TimeInterval) {
    self.recognizer = recognizer
    self.emitter = emitter
    self.silence = silence
  }

  func start() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { fail("no audio input device") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.append(buffer)
    }
    engine.prepare()
    try engine.start()
    beginUtterance()
  }

  func stop() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    lock.lock()
    let last = current
    current = nil
    lock.unlock()
    if let last { deliver(last) }
  }

  private func append(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    let utterance = current
    lock.unlock()
    utterance?.request.append(buffer)
  }

  private func beginUtterance() {
    let utterance = Utterance()
    utterance.request.requiresOnDeviceRecognition = true
    utterance.request.shouldReportPartialResults = true
    utterance.request.taskHint = .dictation
    utterance.task = recognizer.recognitionTask(with: utterance.request) { [weak self] result, error in
      self?.handle(utterance, result: result, error: error)
    }
    lock.lock()
    current = utterance
    lock.unlock()
  }

  private func isCurrent(_ utterance: Utterance) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return current === utterance
  }

  private func handle(_ utterance: Utterance, result: SFSpeechRecognitionResult?, error: Error?) {
    if let result {
      let text = result.bestTranscription.formattedString
      let changed = !text.isEmpty && text != utterance.text
      if !text.isEmpty { utterance.text = text }
      if result.isFinal {
        // The recognizer ended this request itself (e.g. its own duration limit): start a new one.
        if isCurrent(utterance) { endpointWork?.cancel(); beginUtterance() }
        deliver(utterance)
        return
      }
      if changed && isCurrent(utterance) { fastFailures = 0; armEndpoint() }
    }
    guard let error else { return }
    if !isCurrent(utterance) {
      deliver(utterance)  // the finalizing request failed: keep the words it had
      return
    }
    // The live request died (no speech for a long time, recognizer reset, ...). Keep what it heard and
    // restart, but give up if it keeps failing right away (dictation off, model missing).
    endpointWork?.cancel()
    deliver(utterance)
    if Date().timeIntervalSince(utterance.started) < 2 {
      fastFailures += 1
      if fastFailures >= 5 { fail("recognition keeps failing: \(error.localizedDescription)") }
    } else {
      fastFailures = 0
    }
    lock.lock()
    current = nil
    lock.unlock()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.beginUtterance() }
  }

  /// Ends the utterance once `silence` passes with no new words.
  private func armEndpoint() {
    endpointWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.endpoint() }
    endpointWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + silence, execute: work)
  }

  private func endpoint() {
    lock.lock()
    let ending = current
    lock.unlock()
    guard let ending else { return }
    ending.request.endAudio()
    beginUtterance()
    // Wait briefly for the final (often better punctuated) result, then use the last partial.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard let self, !ending.delivered else { return }
      ending.task?.cancel()
      self.deliver(ending)
    }
  }

  private func deliver(_ utterance: Utterance) {
    guard !utterance.delivered else { return }
    utterance.delivered = true
    let text = utterance.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty { emitter.emit(text) }
  }
}

func requestPermissions(_ then: @escaping () -> Void) {
  SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else { fail("speech recognition not authorized (status \(status.rawValue))") }
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      guard granted else { fail("microphone access denied") }
      DispatchQueue.main.async { then() }
    }
  }
}

let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: options.localeID)) else {
  fail("no speech recognizer for locale \(options.localeID)")
}
guard recognizer.supportsOnDeviceRecognition else {
  fail("on-device recognition is unavailable for \(options.localeID) (enable Dictation for that language)")
}
let listener = Listener(
  recognizer: recognizer,
  emitter: Emitter(postURL: options.postURL, tokenFile: options.tokenFile),
  silence: options.silence)

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler {
    listener.stop()
    exit(0)
  }
  source.resume()
  signalSources.append(source)
}

requestPermissions {
  guard recognizer.isAvailable else { fail("speech recognizer is not available right now") }
  do {
    try listener.start()
  } catch {
    fail("cannot start audio capture: \(error.localizedDescription)")
  }
  log("listening on-device (\(options.localeID), endpoint \(Int(options.silence * 1000)) ms)")
}

RunLoop.main.run()
