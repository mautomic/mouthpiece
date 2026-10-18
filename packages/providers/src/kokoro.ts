import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AudioClip,
  type Logger,
  type SynthesizeOptions,
  singleChunk,
  type TtsProvider,
  trimWavSilence,
  type VoiceInfo,
} from "@mouthpiece/core";

/** The slice of `kokoro-js`'s `KokoroTTS` Mouthpiece uses. Never `stream()`: it hangs (US-019). */
export interface KokoroEngine {
  /**
   * `signal` tells the engine the caller has given up on this render (kokoro-js ignores it; the
   * process engine drops or abandons the request). The caller doesn't wait for the engine to react.
   */
  generate(
    text: string,
    opts: { voice: string; speed?: number; signal?: AbortSignal },
  ): Promise<{ toWav(): ArrayBuffer }>;
  list_voices?(): unknown;
}

export type KokoroLoader = () => Promise<KokoroEngine>;

export const KOKORO_DEFAULT_VOICE = "af_heart";
/** What a clip keeps of Kokoro's padding: almost none before, a sentence pause after. */
const CLIP_SILENCE = { leadMs: 20, trailMs: 250 };
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_DTYPE = "q8";

/** The English voices kokoro-js 1.2.1 accepts, in its own order, with display names. */
const VOICES: readonly (readonly [id: string, name: string])[] = [
  ["af_heart", "Heart"],
  ["af_alloy", "Alloy"],
  ["af_aoede", "Aoede"],
  ["af_bella", "Bella"],
  ["af_jessica", "Jessica"],
  ["af_kore", "Kore"],
  ["af_nicole", "Nicole"],
  ["af_nova", "Nova"],
  ["af_river", "River"],
  ["af_sarah", "Sarah"],
  ["af_sky", "Sky"],
  ["am_adam", "Adam"],
  ["am_echo", "Echo"],
  ["am_eric", "Eric"],
  ["am_fenrir", "Fenrir"],
  ["am_liam", "Liam"],
  ["am_michael", "Michael"],
  ["am_onyx", "Onyx"],
  ["am_puck", "Puck"],
  ["am_santa", "Santa"],
  ["bf_emma", "Emma"],
  ["bf_isabella", "Isabella"],
  ["bm_george", "George"],
  ["bm_lewis", "Lewis"],
  ["bf_alice", "Alice"],
  ["bf_lily", "Lily"],
  ["bm_daniel", "Daniel"],
  ["bm_fable", "Fable"],
];

/** An `a*` voice id is American English; a `b*` one is British. */
export const KOKORO_VOICES: readonly VoiceInfo[] = VOICES.map(([id, name]) => ({
  id,
  name,
  language: id.startsWith("a") ? "en-US" : "en-GB",
}));

/**
 * Render-time allowance per character. Kokoro returns audio only once the whole chunk is rendered
 * (about 20 ms per character on an M4 Pro: 3.3 s for 150 characters), so a fixed first-byte
 * timeout would drop every long chunk to the next provider. 50 leaves room for slower Macs.
 */
export const KOKORO_MS_PER_CHAR = 50;

/** Kokoro's first-byte timeout for `text`: the configured timeout plus the render allowance. */
export function kokoroTimeoutMs(text: string, firstByteTimeoutMs: number): number {
  return firstByteTimeoutMs + text.length * KOKORO_MS_PER_CHAR;
}

const VOICE_IDS = new Set(VOICES.map(([id]) => id));

/** `<home>/kokoro`: its own package root for `kokoro-js` and the model cache (`hf/`). */
export function kokoroHome(home: string): string {
  return join(home, "kokoro");
}

export function isKokoroInstalled(home: string): boolean {
  return existsSync(join(kokoroHome(home), "node_modules", "kokoro-js", "package.json"));
}

/**
 * Loads kokoro-js from `<home>/kokoro/node_modules` (never from the repo). Remote models are off by
 * default: the daemon only uses the model `mouthpiece kokoro install` downloaded.
 */
export function defaultKokoroLoader(
  home: string,
  opts: { allowRemoteModels?: boolean } = {},
): KokoroLoader {
  return async () => {
    const dir = kokoroHome(home);
    // Resolve each package's `exports` entry from <home>/kokoro so kokoro-js's own import of
    // @huggingface/transformers is the same module instance whose `env` is configured here.
    const transformers = await import(Bun.resolveSync("@huggingface/transformers", dir));
    transformers.env.cacheDir = join(dir, "hf");
    transformers.env.allowRemoteModels = opts.allowRemoteModels ?? false;
    const { KokoroTTS } = await import(Bun.resolveSync("kokoro-js", dir));
    return (await KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: KOKORO_DTYPE,
      device: "cpu",
    })) as KokoroEngine;
  };
}

export interface KokoroProviderOptions {
  /** Default voice (`provider.kokoro.voice`). */
  voice: string;
  /** Speaking rate (`provider.kokoro.speed`); 1 when absent. */
  speed?: number;
  load: KokoroLoader;
  log?: Logger;
}

/** Free local TTS (US-019). The engine loads lazily on first use; one WAV per `generate()` call. */
export class KokoroProvider implements TtsProvider {
  readonly name = "kokoro";
  /** `generate()` truncates past ~510 tokens. */
  readonly maxCharsPerRequest = 400;
  readonly pricePerMillionChars = 0;
  /**
   * Every chunk is its own clip, and each break between clips costs about a second (afplay start-up
   * plus the clip's silence), so chunks are as long as Kokoro takes: a summary is one clip, spoken
   * without breaks, at the cost of a later start (~15 ms of rendering a character on an M4 Pro).
   */
  readonly chunking = { firstChars: 400, targetChars: 400 };
  readonly cacheKey: string;
  #engine: Promise<KokoroEngine> | undefined;
  #loadFailureLogged = false;
  /** The configured voice, or the default when it isn't a Kokoro voice. */
  readonly #voice: string;

  constructor(private readonly opts: KokoroProviderOptions) {
    // An unknown voice makes kokoro-js print its whole voice table and throw on every chunk.
    this.#voice = VOICE_IDS.has(opts.voice) ? opts.voice : KOKORO_DEFAULT_VOICE;
    if (this.#voice !== opts.voice) {
      opts.log?.({
        level: "warn",
        msg: "kokoro_voice_invalid",
        voice: opts.voice,
        using: this.#voice,
      });
    }
    // Speed changes the audio, so it is part of the key; the default keeps the old key.
    const speed = opts.speed ?? 1;
    this.cacheKey = `${this.#voice}\0${KOKORO_DTYPE}${speed === 1 ? "" : `\0${speed}`}`;
  }

  /**
   * An abort (stop, skip, pause, or the chain's first-byte timeout) rejects at once, even mid-load
   * or mid-render, so the queue moves on without waiting for the engine; the engine is told through
   * the signal and decides what happens to the render itself.
   */
  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<AudioClip> {
    const { signal } = options;
    signal?.throwIfAborted();
    const engine = await untilAborted(this.#load(), signal);
    // A voice from another provider in the chain (or a typo) is not a Kokoro voice: use ours.
    const voice = options.voice && VOICE_IDS.has(options.voice) ? options.voice : this.#voice;
    const audio = await untilAborted(
      engine.generate(text, { voice, speed: this.opts.speed ?? 1, signal }),
      signal,
    );
    signal?.throwIfAborted();
    // Kokoro pads each clip with ~0.25 s of silence before and ~0.4 s after the speech.
    const wav = trimWavSilence(new Uint8Array(audio.toWav()), CLIP_SILENCE);
    return { format: "wav", chunks: singleChunk(wav) };
  }

  /** Loads the engine and renders a short phrase so the first real item is fast. Never throws. */
  async warmUp(): Promise<void> {
    let engine: KokoroEngine;
    try {
      engine = await this.#load();
    } catch {
      return; // already logged as kokoro_load_failed
    }
    try {
      await engine.generate("Ready.", { voice: this.#voice, speed: this.opts.speed ?? 1 });
    } catch (error) {
      this.opts.log?.({ level: "warn", msg: "kokoro_warmup_failed", error: String(error) });
    }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return KOKORO_VOICES.map((v) => ({ ...v }));
  }

  /** Memoized load; a failure clears the memo so the next call retries, and is logged once. */
  #load(): Promise<KokoroEngine> {
    if (!this.#engine) {
      const attempt = (async () => this.opts.load())(); // a sync throw becomes a rejection
      this.#engine = attempt;
      attempt.then(
        () => {
          this.#loadFailureLogged = false;
        },
        (error) => {
          if (this.#engine === attempt) this.#engine = undefined;
          if (this.#loadFailureLogged) return;
          this.#loadFailureLogged = true;
          this.opts.log?.({ level: "warn", msg: "kokoro_load_failed", error: String(error) });
        },
      );
    }
    return this.#engine;
  }
}

/** Settles like `promise`, or rejects with the signal's reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
