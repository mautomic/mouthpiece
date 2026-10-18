// MouthpiecePlayer.swift: the gap-free audio player for the Mouthpiece daemon (mouthpiece-player).
//
// The daemon writes JSON lines to stdin. Each clip is played right after the one before it, with no
// break, through one AVAudioPlayerNode. Progress goes to stdout as JSON lines.
//
//   in:  {"op":"clip","id":7,"rate":24000,"channels":1,"encoding":"f32le"}   start clip 7 (or "s16le")
//        {"op":"audio","id":7,"data":"<base64 interleaved little-endian PCM>"} once or more
//        {"op":"end","id":7}                                                 clip 7 is complete: play it
//        {"op":"flush"}                                                      stop now, drop every clip
//   out: {"event":"ready"}                   the engine started
//        {"event":"ending","id":7}           clip 7 has under 0.3 s left: send the next clip now
//        {"event":"done","id":7}             clip 7 has been played
//        {"event":"reset"}                   the output device changed; clips not yet done were dropped
//        {"event":"error","message":"…"}     fatal; the process exits 1
//
// Usage: mouthpiece-player               play (exits when stdin closes)
//        mouthpiece-player --self-test   render three clips offline (no sound) and check the joins
import AVFoundation
import Foundation

/// What every clip is converted to before it is scheduled, so clips of any rate join seamlessly.
let outputFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
/// The tail of each clip held back as its own buffer: "ending" fires when only this much is left.
let leadSeconds = 0.3

struct Command: Decodable {
  let op: String
  var id: Int? = nil
  var rate: Double? = nil
  var channels: Int? = nil
  var encoding: String? = nil
  var data: String? = nil
}

/// A clip whose audio is still arriving.
final class Clip {
  let source: AVAudioFormat
  let converter: AVAudioConverter
  var converted: [AVAudioPCMBuffer] = []

  init(source: AVAudioFormat, converter: AVAudioConverter) {
    self.source = source
    self.converter = converter
  }
}

final class StreamPlayer {
  let engine: AVAudioEngine
  let node = AVAudioPlayerNode()
  /// When "done" fires: .dataPlayedBack (heard) when live, .dataConsumed in the offline self-test.
  let doneCallback: AVAudioPlayerNodeCompletionCallbackType
  /// Stops the engine after this long with nothing to play, so the output device can sleep.
  let idleStopSeconds: Double?
  /// Runs node callbacks (an audio thread) on the thread that owns this player's state.
  let deliver: (@escaping () -> Void) -> Void
  let emit: ([String: Any]) -> Void
  var clips: [Int: Clip] = [:]
  /// Clips scheduled on the node and not yet done.
  var playing = 0
  /// Bumped by flush and reset; callbacks from before carry a stale value and are ignored.
  var generation = 0
  var idleTimer: Timer?

  init(
    engine: AVAudioEngine, doneCallback: AVAudioPlayerNodeCompletionCallbackType, idleStopSeconds: Double?,
    deliver: @escaping (@escaping () -> Void) -> Void, emit: @escaping ([String: Any]) -> Void
  ) {
    self.engine = engine
    self.doneCallback = doneCallback
    self.idleStopSeconds = idleStopSeconds
    self.deliver = deliver
    self.emit = emit
    engine.attach(node)
    engine.connect(node, to: engine.mainMixerNode, format: outputFormat)
  }

  func handle(_ command: Command) {
    switch command.op {
    case "clip":
      guard let id = command.id, let rate = command.rate, let channels = command.channels else { return }
      begin(id, rate: rate, channels: channels, encoding: command.encoding ?? "f32le")
    case "audio":
      guard let id = command.id, let data = command.data else { return }
      append(id, base64: data)
    case "end":
      guard let id = command.id else { return }
      finish(id)
    case "flush":
      flush()
    default:
      break
    }
  }

  func begin(_ id: Int, rate: Double, channels: Int, encoding: String) {
    let common: AVAudioCommonFormat = encoding == "s16le" ? .pcmFormatInt16 : .pcmFormatFloat32
    guard
      let source = AVAudioFormat(
        commonFormat: common, sampleRate: rate, channels: AVAudioChannelCount(channels), interleaved: true),
      let converter = AVAudioConverter(from: source, to: outputFormat)
    else {
      log("clip \(id): unsupported format \(encoding) \(rate) Hz × \(channels)")
      return
    }
    converter.downmix = true
    clips[id] = Clip(source: source, converter: converter)
  }

  func append(_ id: Int, base64: String) {
    guard let clip = clips[id], let bytes = Data(base64Encoded: base64) else { return }
    let bytesPerFrame = Int(clip.source.streamDescription.pointee.mBytesPerFrame)
    let frames = AVAudioFrameCount(bytes.count / bytesPerFrame)
    guard frames > 0, let input = AVAudioPCMBuffer(pcmFormat: clip.source, frameCapacity: frames) else { return }
    input.frameLength = frames
    bytes.withUnsafeBytes { raw in
      if let base = raw.baseAddress, let target = input.mutableAudioBufferList.pointee.mBuffers.mData {
        memcpy(target, base, Int(frames) * bytesPerFrame)
      }
    }
    clip.converted.append(contentsOf: convert(clip, input))
  }

  /// Converts `input` to the output format; nil flushes what the converter still holds. Loops
  /// until the converter has nothing more, since one call returns at most one buffer's worth.
  func convert(_ clip: Clip, _ input: AVAudioPCMBuffer?) -> [AVAudioPCMBuffer] {
    var outputs: [AVAudioPCMBuffer] = []
    var given = false
    while let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 8192) {
      var error: NSError?
      let status = clip.converter.convert(to: output, error: &error) { _, inputStatus in
        if let input, !given {
          given = true
          inputStatus.pointee = .haveData
          return input
        }
        inputStatus.pointee = input == nil ? .endOfStream : .noDataNow
        return nil
      }
      if let error {
        log("convert: \(error.localizedDescription)")
        break
      }
      if output.frameLength > 0 { outputs.append(output) }
      if status != .haveData { break }  // .inputRanDry or .endOfStream: nothing more for now
    }
    return outputs
  }

  /// Schedules the clip as a body and a 0.3 s tail: "ending" fires when the body has been played
  /// out, which leaves the daemon the tail's length to send the next clip.
  func finish(_ id: Int) {
    guard let clip = clips.removeValue(forKey: id) else { return }
    clip.converted.append(contentsOf: convert(clip, nil))
    guard let whole = concat(clip.converted) else {
      emit(["event": "ending", "id": id])
      emit(["event": "done", "id": id])
      return
    }
    if !engine.isRunning {
      do {
        try engine.start()
      } catch {
        emit(["event": "error", "message": "could not start audio: \(error.localizedDescription)"])
        exit(1)
      }
    }
    idleTimer?.invalidate()
    let tailFrames = min(AVAudioFrameCount(leadSeconds * outputFormat.sampleRate), whole.frameLength)
    let bodyFrames = whole.frameLength - tailFrames
    let current = generation
    playing += 1
    if bodyFrames > 0 {
      node.scheduleBuffer(slice(whole, from: 0, frames: bodyFrames), completionCallbackType: .dataConsumed) {
        [weak self] _ in
        self?.deliver {
          guard let self, self.generation == current else { return }
          self.emit(["event": "ending", "id": id])
        }
      }
    } else {
      emit(["event": "ending", "id": id])
    }
    node.scheduleBuffer(slice(whole, from: bodyFrames, frames: tailFrames), completionCallbackType: doneCallback) {
      [weak self] _ in
      self?.deliver {
        guard let self, self.generation == current else { return }
        self.playing -= 1
        self.emit(["event": "done", "id": id])
        self.stopWhenIdle()
      }
    }
    if !node.isPlaying { node.play() }
  }

  func flush() {
    generation += 1
    clips.removeAll()
    playing = 0
    node.stop()  // drops every scheduled buffer; their callbacks carry the old generation
    stopWhenIdle()
  }

  /// The output device changed: the engine stopped and dropped what was scheduled.
  func reset() {
    generation += 1
    playing = 0
    node.stop()
    emit(["event": "reset"])
  }

  func stopWhenIdle() {
    guard let seconds = idleStopSeconds, playing == 0 else { return }
    idleTimer?.invalidate()
    idleTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      guard let self, self.playing == 0 else { return }
      self.node.stop()
      self.engine.stop()
    }
  }
}

func concat(_ buffers: [AVAudioPCMBuffer]) -> AVAudioPCMBuffer? {
  let total = buffers.reduce(0) { $0 + $1.frameLength }
  guard total > 0, let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: total) else { return nil }
  for buffer in buffers {
    memcpy(
      out.floatChannelData![0] + Int(out.frameLength), buffer.floatChannelData![0],
      Int(buffer.frameLength) * MemoryLayout<Float>.size)
    out.frameLength += buffer.frameLength
  }
  return out
}

func slice(_ buffer: AVAudioPCMBuffer, from start: AVAudioFrameCount, frames: AVAudioFrameCount) -> AVAudioPCMBuffer {
  let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: max(frames, 1))!
  memcpy(out.floatChannelData![0], buffer.floatChannelData![0] + Int(start), Int(frames) * MemoryLayout<Float>.size)
  out.frameLength = frames
  return out
}

func log(_ message: String) {
  FileHandle.standardError.write(Data("mouthpiece-player: \(message)\n".utf8))
}

func emitLine(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

// MARK: - Self-test

/// Sends a 440 Hz clip, as the daemon would.
func sendTone(_ player: StreamPlayer, id: Int, rate: Double, encoding: String, seconds: Double) {
  var data = Data()
  for i in 0..<Int(rate * seconds) {
    let value = 0.5 * sin(2 * Double.pi * 440 * Double(i) / rate)
    if encoding == "s16le" {
      withUnsafeBytes(of: Int16(value * 32767).littleEndian) { data.append(contentsOf: $0) }
    } else {
      withUnsafeBytes(of: Float(value).bitPattern.littleEndian) { data.append(contentsOf: $0) }
    }
  }
  player.handle(Command(op: "clip", id: id, rate: rate, channels: 1, encoding: encoding))
  player.handle(Command(op: "audio", id: id, data: data.base64EncodedString()))
  player.handle(Command(op: "end", id: id))
}

/// Renders offline (no sound) at real-time pace, as a speaker would consume it. Each clip is sent
/// when the one before reports "ending", as the daemon does: 0.5 s like Kokoro (24 kHz float), 0.5 s
/// like `say` (22.05 kHz 16-bit), then 0.1 s, shorter than the lead. Passes when 1.1 s of audio runs
/// unbroken across both joins and the events come in order.
func selfTest() -> Bool {
  let engine = AVAudioEngine()
  var events: [String] = []
  let player = StreamPlayer(
    engine: engine, doneCallback: .dataConsumed, idleStopSeconds: nil,
    deliver: { DispatchQueue.main.async(execute: $0) },
    emit: { event in events.append("\(event["event"] ?? "") \(event["id"] ?? "")") })
  let sliceFrames: AVAudioFrameCount = 480  // 10 ms
  do {
    try engine.enableManualRenderingMode(.offline, format: outputFormat, maximumFrameCount: sliceFrames)
    try engine.start()
  } catch {
    print("self-test: could not start offline rendering: \(error)")
    return false
  }
  sendTone(player, id: 1, rate: 24_000, encoding: "f32le", seconds: 0.5)
  var samples: [Float] = []
  let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: sliceFrames)!
  var sent = 1
  for _ in 0..<200 {  // 2 s
    do {
      _ = try engine.renderOffline(sliceFrames, to: buffer)
    } catch {
      print("self-test: render failed: \(error)")
      return false
    }
    samples.append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
    // 10 ms of wall clock per 10 ms slice; meanwhile the node's callbacks arrive on the main queue.
    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    if sent == 1 && events.contains("ending 1") {
      sent = 2
      sendTone(player, id: 2, rate: 22_050, encoding: "s16le", seconds: 0.5)
    } else if sent == 2 && events.contains("ending 2") {
      sent = 3
      sendTone(player, id: 3, rate: 24_000, encoding: "f32le", seconds: 0.1)
    }
  }
  guard let first = samples.firstIndex(where: { abs($0) > 0.05 }),
    let last = samples.lastIndex(where: { abs($0) > 0.05 })
  else {
    print("self-test: no audio rendered")
    return false
  }
  let seconds = Double(last - first) / outputFormat.sampleRate
  // 5 ms windows of a 0.5-amplitude sine have an RMS near 0.35; a break would show as near 0.
  let window = 240
  var quietest = Float.greatestFiniteMagnitude
  var start = first
  while start + window <= last {
    let rms = sqrt(samples[start..<start + window].reduce(0) { $0 + $1 * $1 } / Float(window))
    quietest = min(quietest, rms)
    start += window
  }
  // Clip 3 is all tail, so it reports "ending" as soon as it is scheduled.
  let expected = ["ending 1", "done 1", "ending 2", "ending 3", "done 2", "done 3"]
  print("self-test: \(String(format: "%.3f", seconds)) s of audio, quietest 5 ms window RMS \(quietest), events \(events)")
  return abs(seconds - 1.1) < 0.02 && quietest > 0.2 && events == expected
}

// MARK: - Main

if CommandLine.arguments.contains("--self-test") { exit(selfTest() ? 0 : 1) }

let engine = AVAudioEngine()
let player = StreamPlayer(
  engine: engine, doneCallback: .dataPlayedBack, idleStopSeconds: 30,
  deliver: { DispatchQueue.main.async(execute: $0) }, emit: emitLine)
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
  player.reset()
}
do {
  try engine.start()
} catch {
  emitLine(["event": "error", "message": "could not start audio: \(error.localizedDescription)"])
  exit(1)
}
emitLine(["event": "ready"])
player.stopWhenIdle()
Thread.detachNewThread {
  let decoder = JSONDecoder()
  while let line = readLine(strippingNewline: true) {
    guard let command = try? decoder.decode(Command.self, from: Data(line.utf8)) else { continue }
    DispatchQueue.main.async { player.handle(command) }
  }
  exit(0)  // the daemon closed stdin
}
dispatchMain()
