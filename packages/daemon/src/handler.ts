import { timingSafeEqual } from "node:crypto";
import {
  type HealthResponse,
  type InterruptRequest,
  type InterruptResult,
  type ModeRequest,
  type ModeState,
  type NormalizedSpeakEvent,
  type PauseResponse,
  parseInterruptRequest,
  parseModeRequest,
  parsePauseRequest,
  parseReplayRequest,
  parseSettingsUpdate,
  parseSpeakEvent,
  type ReplayRequest,
  type ReplayResponse,
  type SettingsResponse,
  type SettingsUpdate,
  type SpeakResponse,
  type StatusResponse,
  type UsageReport,
  type VoicesResponse,
} from "@mouthpiece/core";
import type { SaveResult } from "./settings.ts";

export const MAX_BODY_BYTES = 1_000_000;

export interface HandlerDeps {
  token: string;
  version: string;
  providerName(): string;
  queueDepth(): number;
  enqueue(event: NormalizedSpeakEvent): SpeakResponse;
  interrupt(request: InterruptRequest): InterruptResult;
  stopAll(): InterruptResult;
  skip(): { skipped: boolean };
  getMode(): ModeState;
  setMode(req: ModeRequest): ModeState;
  replay(req: ReplayRequest): ReplayResponse;
  /** Throws (or rejects) for a malformed month; the handler maps that to 400. */
  usage(month: string | undefined): UsageReport | Promise<UsageReport>;
  /**
   * Every provider's voices (US-015), or only `provider`'s when given. One provider's failure is an
   * `error` entry, not a rejection.
   */
  voices(provider: string | undefined): Promise<VoicesResponse>;
  /** What the daemon is doing right now (US-018). */
  status(): StatusResponse;
  /** Adds a pause reason (US-022). */
  pause(reason: string): PauseResponse;
  /** Removes a pause reason (US-022). */
  resume(reason: string): PauseResponse;
  /** What the menubar's Settings menu shows (US-018). */
  settings(): SettingsResponse;
  /** Saves a settings change to the config file and applies it. */
  updateSettings(update: SettingsUpdate): Promise<SaveResult>;
}

type Method = "GET" | "POST";
type Route = { auth: boolean; run: (body: unknown, url: URL) => Response | Promise<Response> };

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const pauseRoute =
    (apply: (reason: string) => PauseResponse): Route["run"] =>
    (body) => {
      const parsed = parsePauseRequest(body);
      return parsed.ok ? json(200, apply(parsed.value.reason)) : json(400, { error: parsed.error });
    };
  const routes: Record<string, Partial<Record<Method, Route>>> = {
    "/v1/health": {
      GET: {
        auth: false,
        run: () => {
          const body: HealthResponse = {
            ok: true,
            version: deps.version,
            provider: deps.providerName(),
            queueDepth: deps.queueDepth(),
          };
          return json(200, body);
        },
      },
    },
    "/v1/speak": {
      POST: {
        auth: true,
        run: (body) => {
          const parsed = parseSpeakEvent(body);
          return parsed.ok
            ? json(202, deps.enqueue(parsed.value))
            : json(400, { error: parsed.error });
        },
      },
    },
    "/v1/interrupt": {
      POST: {
        auth: true,
        run: (body) => {
          const parsed = parseInterruptRequest(body);
          return parsed.ok
            ? json(200, deps.interrupt(parsed.value))
            : json(400, { error: parsed.error });
        },
      },
    },
    "/v1/stop": { POST: { auth: true, run: () => json(200, deps.stopAll()) } },
    "/v1/skip": { POST: { auth: true, run: () => json(200, deps.skip()) } },
    "/v1/mode": {
      GET: { auth: true, run: () => json(200, deps.getMode()) },
      POST: {
        auth: true,
        run: (body) => {
          const parsed = parseModeRequest(body);
          return parsed.ok
            ? json(200, deps.setMode(parsed.value))
            : json(400, { error: parsed.error });
        },
      },
    },
    "/v1/replay": {
      POST: {
        auth: true,
        run: (body) => {
          const parsed = parseReplayRequest(body);
          return parsed.ok
            ? json(200, deps.replay(parsed.value))
            : json(400, { error: parsed.error });
        },
      },
    },
    "/v1/usage": {
      GET: {
        auth: true,
        run: async (_body, url) => {
          try {
            return json(200, await deps.usage(url.searchParams.get("month") ?? undefined));
          } catch (error) {
            return json(400, { error: (error as Error).message });
          }
        },
      },
    },
    "/v1/voices": {
      GET: {
        auth: true,
        run: async (_body, url) => {
          try {
            return json(200, await deps.voices(url.searchParams.get("provider") ?? undefined));
          } catch (error) {
            return json(500, { error: (error as Error).message });
          }
        },
      },
    },
    "/v1/status": { GET: { auth: true, run: () => json(200, deps.status()) } },
    "/v1/pause": { POST: { auth: true, run: pauseRoute((reason) => deps.pause(reason)) } },
    "/v1/resume": { POST: { auth: true, run: pauseRoute((reason) => deps.resume(reason)) } },
    "/v1/settings": {
      GET: { auth: true, run: () => json(200, deps.settings()) },
      POST: {
        auth: true,
        run: async (body) => {
          const parsed = parseSettingsUpdate(body);
          if (!parsed.ok) return json(400, { error: parsed.error });
          const saved = await deps.updateSettings(parsed.value);
          return saved.ok ? json(200, deps.settings()) : json(saved.status, { error: saved.error });
        },
      },
    },
  };

  return async (req) => {
    const url = new URL(req.url);
    const methods = routes[url.pathname];
    if (!methods) return json(404, { error: "not found" });
    const route = Object.hasOwn(methods, req.method) ? methods[req.method as Method] : undefined;
    if (!route) {
      const allow = Object.keys(methods).sort().join(", ");
      return json(405, { error: "method not allowed" }, { Allow: allow });
    }
    if (route.auth && !authorized(req, deps.token)) return json(401, { error: "unauthorized" });
    let body: unknown;
    if (req.method === "POST") {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json(413, { error: "body too large" });
      try {
        body = text === "" ? {} : JSON.parse(text);
      } catch {
        return json(400, { error: "body must be valid JSON" });
      }
    }
    return route.run(body, url);
  };
}

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
