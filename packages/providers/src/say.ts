import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AudioClip,
  type SynthesizeOptions,
  singleChunk,
  type TtsProvider,
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
      const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
      const onAbort = () => proc.kill();
      options.signal?.addEventListener("abort", onAbort, { once: true });
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
}
