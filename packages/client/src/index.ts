import {
  daemonUrl,
  type Env,
  type HealthResponse,
  type InboxDismissRequest,
  type InboxDismissResponse,
  type InboxResponse,
  type InterruptRequest,
  type InterruptResult,
  localDaemonUrl,
  type ModeRequest,
  type ModeState,
  mouthpieceHome,
  type PauseRequest,
  type PauseResponse,
  type ReplayRequest,
  type ReplayResponse,
  type ReplyRequest,
  type ReplyResponse,
  type ReplySubmitRequest,
  readToken,
  type SettingsResponse,
  type SettingsUpdate,
  type ShutdownResponse,
  type SpeakEvent,
  type SpeakResponse,
  type StatusResponse,
  type UsageReport,
  type VoicesResponse,
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
    readonly reason?: string,
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
  const base = localDaemonUrl(opts.url ?? daemonUrl(env));
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
  let data: unknown;
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
    const reason = (data as { reason?: unknown }).reason;
    throw new MouthpieceError(
      message,
      response.status,
      typeof reason === "string" ? reason : undefined,
    );
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
export const getMode = (opts: ClientOptions = {}) =>
  request<ModeState>("GET", "/v1/mode", undefined, opts);
export const setMode = (req: ModeRequest, opts: ClientOptions = {}) =>
  request<ModeState>("POST", "/v1/mode", req, opts);
export const replay = (req: ReplayRequest = {}, opts: ClientOptions = {}) =>
  request<ReplayResponse>("POST", "/v1/replay", req, opts);
export const usage = (opts: ClientOptions & { month?: string } = {}) =>
  request<UsageReport>(
    "GET",
    `/v1/usage${opts.month ? `?month=${encodeURIComponent(opts.month)}` : ""}`,
    undefined,
    opts,
  );
export const voices = (opts: ClientOptions & { provider?: string } = {}) =>
  request<VoicesResponse>(
    "GET",
    `/v1/voices${opts.provider ? `?provider=${encodeURIComponent(opts.provider)}` : ""}`,
    undefined,
    opts,
  );
export const status = (opts: ClientOptions = {}) =>
  request<StatusResponse>("GET", "/v1/status", undefined, opts);
export const pause = (reason = "user", opts: ClientOptions = {}) =>
  request<PauseResponse>("POST", "/v1/pause", { reason } satisfies PauseRequest, opts);
export const resume = (reason = "user", opts: ClientOptions = {}) =>
  request<PauseResponse>("POST", "/v1/resume", { reason } satisfies PauseRequest, opts);
export const shutdown = (opts: ClientOptions = {}) =>
  request<ShutdownResponse>("POST", "/v1/shutdown", undefined, opts);
export const getSettings = (opts: ClientOptions = {}) =>
  request<SettingsResponse>("GET", "/v1/settings", undefined, opts);
export const updateSettings = (update: SettingsUpdate, opts: ClientOptions = {}) =>
  request<SettingsResponse>("POST", "/v1/settings", update, opts);

/** A reply waits on the terminal (up to ~19 s in the daemon); keep the client above that. */
export const REPLY_TIMEOUT_MS = 25_000;
export const inbox = (opts: ClientOptions = {}) =>
  request<InboxResponse>("GET", "/v1/inbox", undefined, opts);
export const reply = (req: ReplyRequest, opts: ClientOptions = {}) =>
  request<ReplyResponse>("POST", "/v1/reply", req, { timeoutMs: REPLY_TIMEOUT_MS, ...opts });
export const submitReply = (req: ReplySubmitRequest, opts: ClientOptions = {}) =>
  request<ReplyResponse>("POST", "/v1/reply/submit", req, {
    timeoutMs: REPLY_TIMEOUT_MS,
    ...opts,
  });
export const dismissInbox = (req: InboxDismissRequest, opts: ClientOptions = {}) =>
  request<InboxDismissResponse>("POST", "/v1/inbox/dismiss", req, opts);
