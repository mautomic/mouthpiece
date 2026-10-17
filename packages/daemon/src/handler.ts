import { timingSafeEqual } from "node:crypto";
import {
  type HealthResponse,
  type InterruptRequest,
  type InterruptResult,
  type ModeRequest,
  type ModeState,
  type NormalizedSpeakEvent,
  parseInterruptRequest,
  parseModeRequest,
  parseReplayRequest,
  parseSpeakEvent,
  type ReplayRequest,
  type ReplayResponse,
  type SpeakResponse,
  type UsageReport,
  type VoicesResponse,
} from "@mouthpiece/core";

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
  /*
   * Phase 2 (US-010, US-016). Optional only until the daemon wires them (Task 9);
   * a route whose dep is missing answers 501.
   */
  getMode?(): ModeState;
  setMode?(req: ModeRequest): ModeState;
  replay?(req: ReplayRequest): ReplayResponse;
  /** Throws (or rejects) for a malformed month; the handler maps that to 400. */
  usage?(month: string | undefined): UsageReport | Promise<UsageReport>;
  /**
   * Phase 3 (US-015). Every provider's voices, or only `provider`'s when given. One provider's
   * failure is an `error` entry, not a rejection. Optional until the daemon wires it; 501 without.
   */
  voices?(provider: string | undefined): Promise<VoicesResponse>;
}

type Method = "GET" | "POST";
type Route = { auth: boolean; run: (body: unknown, url: URL) => Response | Promise<Response> };

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

const unavailable = () => json(501, { error: "not available" });

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
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
      GET: { auth: true, run: () => (deps.getMode ? json(200, deps.getMode()) : unavailable()) },
      POST: {
        auth: true,
        run: (body) => {
          if (!deps.setMode) return unavailable();
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
          if (!deps.replay) return unavailable();
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
          if (!deps.usage) return unavailable();
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
          if (!deps.voices) return unavailable();
          try {
            return json(200, await deps.voices(url.searchParams.get("provider") ?? undefined));
          } catch (error) {
            return json(500, { error: (error as Error).message });
          }
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
