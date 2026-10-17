import {
  daemonUrl,
  type Env,
  type HealthResponse,
  type InterruptRequest,
  type InterruptResult,
  mouthpieceHome,
  readToken,
  type SpeakEvent,
  type SpeakResponse,
} from "@mouthpiece/core";

export interface ClientOptions {
  url?: string;
  token?: string;
  home?: string;
  timeoutMs?: number;
  env?: Env;
  fetch?: typeof fetch;
}

export class MouthpieceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 2000;

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  opts: ClientOptions,
): Promise<T> {
  const env = opts.env ?? process.env;
  const base = opts.url ?? daemonUrl(env);
  const token =
    opts.token ?? env.MOUTHPIECE_TOKEN ?? (await readToken(opts.home ?? mouthpieceHome(env)));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await (opts.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MouthpieceError(
      `mouthpiece daemon unreachable at ${base}: ${(error as Error).message}`,
    );
  }
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new MouthpieceError(
      `invalid response from daemon: ${text.slice(0, 200)}`,
      response.status,
    );
  }
  if (!response.ok) {
    const message = (data as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new MouthpieceError(message, response.status);
  }
  return data as T;
}

export const speak = (event: SpeakEvent, opts: ClientOptions = {}) =>
  request<SpeakResponse>("POST", "/v1/speak", event, opts);
export const interrupt = (req: InterruptRequest, opts: ClientOptions = {}) =>
  request<InterruptResult>("POST", "/v1/interrupt", req, opts);
export const stop = (opts: ClientOptions = {}) =>
  request<InterruptResult>("POST", "/v1/stop", undefined, opts);
export const skip = (opts: ClientOptions = {}) =>
  request<{ skipped: boolean }>("POST", "/v1/skip", undefined, opts);
export const health = (opts: ClientOptions = {}) =>
  request<HealthResponse>("GET", "/v1/health", undefined, opts);
