import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AudioClip,
  type Logger,
  type SynthesizeOptions,
  singleChunk,
  type TtsProvider,
  type VoiceInfo,
} from "@mouthpiece/core";

export interface SayProviderOptions {
  tmpDir: string;
  voice?: string;
  command?: string;
  /**
   * Receives a warning when a voice is not installed and `say` falls back to the system voice.
   * macOS currently falls back on its own (`say -v <unknown>` exits 0); the retry covers non-zero exits.
   */
  log?: Logger;
}

export class SayProvider implements TtsProvider {
  readonly name = "say";
  readonly maxCharsPerRequest = 4000;
  readonly pricePerMillionChars = 0;

  constructor(private readonly opts: SayProviderOptions) {}

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    await mkdir(this.opts.tmpDir, { recursive: true });
    const id = crypto.randomUUID();
    const inPath = join(this.opts.tmpDir, `${id}.txt`);
    const outPath = join(this.opts.tmpDir, `${id}.wav`);
    // Text goes through a file so it can never be parsed as a CLI flag.
    await Bun.write(inPath, text);
    try {
      const voice = options.voice ?? this.opts.voice;
      let result = await this.#render(inPath, outPath, voice, options.signal);
      if (result.code !== 0 && voice) {
        // The voice may belong to another provider in the chain (e.g. an ElevenLabs id) or not be
        // installed. `say` is the last resort (FR-8), so speak in the system voice rather than fail.
        this.opts.log?.({
          level: "warn",
          msg: "say_voice_failed",
          voice,
          error: `say exited with ${result.code}: ${result.stderr}`,
        });
        result = await this.#render(inPath, outPath, undefined, options.signal);
      }
      if (result.code !== 0) throw new Error(`say exited with ${result.code}: ${result.stderr}`);
      const bytes = new Uint8Array(await Bun.file(outPath).arrayBuffer());
      return { format: "wav", chunks: singleChunk(bytes) };
    } finally {
      await rm(inPath, { force: true });
      await rm(outPath, { force: true });
    }
  }

  /** Runs `say` once; rejects only when aborted. */
  async #render(
    inPath: string,
    outPath: string,
    voice: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ code: number; stderr: string }> {
    // 16-bit WAV (not say's default AIFF) so the gap-free player can take it (US-005).
    const args = [
      this.opts.command ?? "say",
      "-f",
      inPath,
      "-o",
      outPath,
      "--file-format=WAVE",
      "--data-format=LEI16@24000",
    ];
    if (voice) args.push("-v", voice);
    signal?.throwIfAborted();
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    // An abort that landed before the listener existed would otherwise never fire.
    if (signal?.aborted) proc.kill();
    try {
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      signal?.throwIfAborted();
      return { code, stderr: stderr.trim() };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Voices installed on this Mac, from `say -v '?'`. */
  async listVoices(): Promise<VoiceInfo[]> {
    const proc = Bun.spawn([this.opts.command ?? "say", "-v", "?"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`say exited with ${code}: ${stderr.trim()}`);
    return parseSayVoices(stdout);
  }
}

/**
 * `say -v '?'` lines look like `Ava (Premium)       en_US    # Hello, my name is Ava.`. Long names
 * leave a single space before the locale (`Eddy (English (UK)) en_GB    # …`).
 */
const SAY_VOICE_LINE = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/;

/** Parses `say -v '?'` output; lines that don't match are skipped. */
export function parseSayVoices(output: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of output.split("\n")) {
    const match = SAY_VOICE_LINE.exec(line);
    const name = match?.[1]?.trim();
    if (!match?.[2] || !name) continue;
    voices.push({ id: name, name, language: match[2].replace("_", "-") });
  }
  return voices;
}
