import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AudioClip,
  type SynthesizeOptions,
  singleChunk,
  type TtsProvider,
  type VoiceInfo,
} from "@mouthpiece/core";

export interface SayProviderOptions {
  tmpDir: string;
  voice?: string;
  command?: string;
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
    const outPath = join(this.opts.tmpDir, `${id}.aiff`);
    // Text goes through a file so it can never be parsed as a CLI flag.
    await Bun.write(inPath, text);
    try {
      const args = [this.opts.command ?? "say", "-f", inPath, "-o", outPath];
      const voice = options.voice ?? this.opts.voice;
      if (voice) args.push("-v", voice);
      options.signal?.throwIfAborted();
      const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
      const onAbort = () => proc.kill();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // An abort that landed before the listener existed would otherwise never fire.
      if (options.signal?.aborted) proc.kill();
      try {
        const code = await proc.exited;
        options.signal?.throwIfAborted();
        if (code !== 0)
          throw new Error(
            `say exited with ${code}: ${(await new Response(proc.stderr).text()).trim()}`,
          );
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
      const bytes = new Uint8Array(await Bun.file(outPath).arrayBuffer());
      return { format: "aiff", chunks: singleChunk(bytes) };
    } finally {
      await rm(inPath, { force: true });
      await rm(outPath, { force: true });
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
