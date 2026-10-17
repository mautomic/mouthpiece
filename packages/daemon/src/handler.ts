import { timingSafeEqual } from "node:crypto";
import {
  type HealthResponse,
  type InterruptRequest,
  type InterruptResult,
  type NormalizedSpeakEvent,
  parseInterruptRequest,
  parseSpeakEvent,
  type SpeakResponse,
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
}

type Route = { method: "GET" | "POST"; auth: boolean; run: (body: unknown) => Response };

const json = (status: number, body: unknown) => Response.json(body, { status });

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const routes: Record<string, Route> = {
    "/v1/health": {
      method: "GET",
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
    "/v1/speak": {
      method: "POST",
      auth: true,
      run: (body) => {
        const parsed = parseSpeakEvent(body);
        return parsed.ok
          ? json(202, deps.enqueue(parsed.value))
          : json(400, { error: parsed.error });
      },
    },
    "/v1/interrupt": {
      method: "POST",
      auth: true,
      run: (body) => {
        const parsed = parseInterruptRequest(body);
        return parsed.ok
          ? json(200, deps.interrupt(parsed.value))
          : json(400, { error: parsed.error });
      },
    },
    "/v1/stop": { method: "POST", auth: true, run: () => json(200, deps.stopAll()) },
    "/v1/skip": { method: "POST", auth: true, run: () => json(200, deps.skip()) },
  };

  return async (req) => {
    const route = routes[new URL(req.url).pathname];
    if (!route) return json(404, { error: "not found" });
    if (req.method !== route.method) {
      return Response.json(
        { error: "method not allowed" },
        { status: 405, headers: { Allow: route.method } },
      );
    }
    if (route.auth && !authorized(req, deps.token)) return json(401, { error: "unauthorized" });
    let body: unknown;
    if (route.method === "POST") {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json(413, { error: "body too large" });
      try {
        body = text === "" ? {} : JSON.parse(text);
      } catch {
        return json(400, { error: "body must be valid JSON" });
      }
    }
    return route.run(body);
  };
}

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
