import type { AudioClip } from "@mouthpiece/core";

/** Fail a stream if no bytes arrive for this long. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10_000;

/** A provider HTTP failure. Status 0 means the stream failed after the response started. */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(`${provider} HTTP ${status}: ${message}`);
    this.name = "ProviderHttpError";
  }
}

/** Extracts the message from the JSON error shapes TTS providers use, falling back to the raw text. */
export async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  const message = jsonErrorMessage(text);
  return message ?? (text.slice(0, 300) || "no body");
}

function jsonErrorMessage(text: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(json)) return undefined;
  const detail = json.detail;
  if (isObject(detail) && typeof detail.message === "string") return detail.message; // ElevenLabs
  if (Array.isArray(detail) && isObject(detail[0]) && typeof detail[0].msg === "string")
    return detail[0].msg; // ElevenLabs 422
  if (typeof json.err_msg === "string") return json.err_msg; // Deepgram
  if (typeof json.message === "string") return json.message; // Deepgram (category/message)
  if (isObject(json.error) && typeof json.error.message === "string") return json.error.message; // OpenAI
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StreamBodyOptions {
  idleTimeoutMs: number;
  provider: string;
  signal?: AbortSignal;
}

/** Yields a response body's chunks; throws `ProviderHttpError` (status 0) when it stalls. */
export async function* streamBody(
  body: ReadableStream<Uint8Array>,
  opts: StreamBodyOptions,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await read(reader, opts);
      if (done) return;
      if (value?.length) yield value;
    }
  } finally {
    // Releases the connection when the consumer stops early, stalls out, or is aborted.
    reader.cancel().catch(() => {});
  }
}

function read(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  { idleTimeoutMs, provider, signal }: StreamBodyOptions,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => reject(new ProviderHttpError(provider, 0, `stream stalled for ${idleTimeoutMs}ms`)),
      idleTimeoutMs,
    );
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      });
  });
}

export interface StreamingClipOptions {
  provider: string;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Turns a raw-MP3 streaming response into a clip. Rejects on an HTTP error, and resolves only once
 * the first audio bytes arrive (TtsProvider contract), so the fallback chain's first-byte timeout
 * covers a response that starts but never sends audio (FR-8).
 */
export async function streamingClip(
  res: Response,
  { provider, idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS, signal }: StreamingClipOptions,
): Promise<AudioClip> {
  if (!res.ok || !res.body)
    throw new ProviderHttpError(provider, res.status, await readErrorMessage(res));
  const stream = streamBody(res.body, { idleTimeoutMs, provider, signal })[Symbol.asyncIterator]();
  const first = await stream.next();
  if (first.done) throw new ProviderHttpError(provider, res.status, "stream ended without audio");
  return { format: "mp3", chunks: prepend(first.value, stream) };
}

export async function* prepend(
  first: Uint8Array,
  rest: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  try {
    yield first;
    for (let next = await rest.next(); !next.done; next = await rest.next()) yield next.value;
  } finally {
    await rest.return?.();
  }
}

/** GETs JSON, rejecting with `ProviderHttpError` on an HTTP error. */
export async function getJson(
  fetchFn: typeof fetch,
  provider: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetchFn(url, { headers });
  if (!res.ok) throw new ProviderHttpError(provider, res.status, await readErrorMessage(res));
  return res.json();
}
