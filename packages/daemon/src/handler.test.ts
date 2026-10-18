import { expect, test } from "bun:test";
import type { NormalizedSpeakEvent, StatusResponse } from "@mouthpiece/core";
import { createHandler, type HandlerDeps } from "./handler.ts";

const TOKEN = "t".repeat(64);

function setup(overrides: Partial<HandlerDeps> = {}) {
  const enqueued: NormalizedSpeakEvent[] = [];
  const voiceCalls: (string | undefined)[] = [];
  const pauseCalls: string[] = [];
  const deps: HandlerDeps = {
    token: TOKEN,
    version: "0.1.0",
    providerName: () => "say",
    queueDepth: () => 2,
    enqueue: (e) => {
      enqueued.push(e);
      return { id: "id-1" };
    },
    interrupt: () => ({ stopped: true, dropped: 1 }),
    stopAll: () => ({ stopped: false, dropped: 3 }),
    skip: () => ({ skipped: true }),
    getMode: () => ({ default: "summary", overrides: [] }),
    setMode: (r) => ({ default: r.mode ?? "full", overrides: [] }),
    replay: (r) => ({ id: r.full ? "full-id" : "id" }),
    usage: (month) => {
      if (month === "bad") throw new Error("month must be YYYY-MM");
      return { from: "a", to: "b", rows: [], quotas: [] };
    },
    voices: async (provider) => {
      voiceCalls.push(provider);
      return {
        providers: [
          { provider: provider ?? "say", voices: [{ id: "Samantha", name: "Samantha" }] },
          { provider: "inworld", voices: [], error: "HTTP 401" },
        ],
      };
    },
    status: () => STATUS,
    pause: (reason) => {
      pauseCalls.push(`pause:${reason}`);
      return { paused: true, pauseReasons: [reason] };
    },
    resume: (reason) => {
      pauseCalls.push(`resume:${reason}`);
      return { paused: false, pauseReasons: [] };
    },
    ...overrides,
  };
  return { handle: createHandler(deps), enqueued, voiceCalls, pauseCalls };
}

const STATUS: StatusResponse = {
  version: "0.1.0",
  speaking: true,
  paused: false,
  pauseReasons: [],
  mode: "summary",
  queueDepth: 2,
  provider: "say",
  current: { source: "cli", label: "web" },
};

const req = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
  new Request(`http://127.0.0.1:7317${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

test("health needs no auth", async () => {
  const res = await setup().handle(req("GET", "/v1/health", undefined, null));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: "0.1.0", provider: "say", queueDepth: 2 });
});

test.each([null, "wrong"])("speak rejects token %p", async (token) => {
  const res = await setup().handle(req("POST", "/v1/speak", { text: "hi", source: "cli" }, token));
  expect(res.status).toBe(401);
});

test("speak enqueues the normalized event", async () => {
  const { handle, enqueued } = setup();
  const res = await handle(
    req("POST", "/v1/speak", { text: "Hello there", source: "cli", label: "x" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ id: "id-1" });
  expect(enqueued[0]).toMatchObject({
    text: "Hello there",
    source: "cli",
    label: "x",
    conversationId: "default",
  });
});

test("speak passes through skipped results", async () => {
  const { handle } = setup({ enqueue: () => ({ id: null, skipped: "trivial" }) });
  expect(
    await (await handle(req("POST", "/v1/speak", { text: "ok", source: "cli" }))).json(),
  ).toEqual({ id: null, skipped: "trivial" });
});

test("bad JSON and invalid envelopes are 400 with a message", async () => {
  const { handle } = setup();
  const bad = await handle(req("POST", "/v1/speak", "{not json"));
  expect(bad.status).toBe(400);
  const invalid = await handle(req("POST", "/v1/speak", { text: "", source: "cli" }));
  expect(invalid.status).toBe(400);
  expect(((await invalid.json()) as { error: string }).error).toContain("text");
});

test("oversized bodies are 413", async () => {
  const res = await setup().handle(req("POST", "/v1/speak", "x".repeat(1_000_001)));
  expect(res.status).toBe(413);
});

test("interrupt, stop, skip", async () => {
  const { handle } = setup();
  expect(
    await (
      await handle(req("POST", "/v1/interrupt", { source: "cli", conversationId: "a" }))
    ).json(),
  ).toEqual({ stopped: true, dropped: 1 });
  expect((await handle(req("POST", "/v1/interrupt", {}))).status).toBe(400);
  expect(await (await handle(req("POST", "/v1/stop"))).json()).toEqual({
    stopped: false,
    dropped: 3,
  });
  expect(await (await handle(req("POST", "/v1/skip"))).json()).toEqual({ skipped: true });
});

test("unknown path is 404; wrong method is 405 with Allow", async () => {
  const { handle } = setup();
  expect((await handle(req("GET", "/v2/nope"))).status).toBe(404);
  const res = await handle(req("GET", "/v1/speak"));
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
});

test("mode GET and POST share a path; validation errors are 400", async () => {
  const { handle } = setup();
  expect(await (await handle(req("GET", "/v1/mode"))).json()).toEqual({
    default: "summary",
    overrides: [],
  });
  expect(await (await handle(req("POST", "/v1/mode", { mode: "off" }))).json()).toEqual({
    default: "off",
    overrides: [],
  });
  expect((await handle(req("POST", "/v1/mode", {}))).status).toBe(400);
  const del = await handle(req("DELETE", "/v1/mode"));
  expect(del.status).toBe(405);
  expect(del.headers.get("allow")).toBe("GET, POST");
});

test("replay and usage", async () => {
  const { handle } = setup();
  expect(await (await handle(req("POST", "/v1/replay", { full: true }))).json()).toEqual({
    id: "full-id",
  });
  expect((await handle(req("GET", "/v1/usage?month=2026-10"))).status).toBe(200);
  expect((await handle(req("GET", "/v1/usage?month=bad"))).status).toBe(400);
  expect((await handle(req("GET", "/v1/usage", undefined, null))).status).toBe(401);
});

test("voices lists every provider, including error entries", async () => {
  const { handle, voiceCalls } = setup();
  const res = await handle(req("GET", "/v1/voices"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    providers: [
      { provider: "say", voices: [{ id: "Samantha", name: "Samantha" }] },
      { provider: "inworld", voices: [], error: "HTTP 401" },
    ],
  });
  expect(voiceCalls).toEqual([undefined]);
});

test("voices passes ?provider= through", async () => {
  const { handle, voiceCalls } = setup();
  const res = await handle(req("GET", "/v1/voices?provider=openai"));
  expect(res.status).toBe(200);
  expect(voiceCalls).toEqual(["openai"]);
});

test("voices requires auth", async () => {
  const { handle, voiceCalls } = setup();
  expect((await handle(req("GET", "/v1/voices", undefined, null))).status).toBe(401);
  expect(voiceCalls).toEqual([]);
});

test("voices answers 500 when it throws", async () => {
  const failing = setup({
    voices: async () => {
      throw new Error("boom");
    },
  });
  const res = await failing.handle(req("GET", "/v1/voices"));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "boom" });
});

test("usage may be async; a rejected month is still 400", async () => {
  const { handle } = setup({
    usage: async (month) => {
      if (month === "bad") throw new Error("month must be YYYY-MM");
      return { from: month ?? "cycle", to: "b", rows: [], quotas: [] };
    },
  });
  const ok = await handle(req("GET", "/v1/usage?month=2026-10"));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ from: "2026-10", to: "b", rows: [], quotas: [] });
  const bad = await handle(req("GET", "/v1/usage?month=bad"));
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "month must be YYYY-MM" });
  expect((await handle(req("GET", "/v1/usage", undefined, null))).status).toBe(401);
});

test("status returns the daemon's status (US-018)", async () => {
  const res = await setup().handle(req("GET", "/v1/status"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(STATUS);
});

test("pause and resume pass the reason through (US-022)", async () => {
  const { handle, pauseCalls } = setup();
  const paused = await handle(req("POST", "/v1/pause", { reason: "mic" }));
  expect(paused.status).toBe(200);
  expect(await paused.json()).toEqual({ paused: true, pauseReasons: ["mic"] });
  const resumed = await handle(req("POST", "/v1/resume", { reason: "mic" }));
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toEqual({ paused: false, pauseReasons: [] });
  expect(pauseCalls).toEqual(["pause:mic", "resume:mic"]);
});

test("pause and resume default the reason to user, with or without a body", async () => {
  const { handle, pauseCalls } = setup();
  expect((await handle(req("POST", "/v1/pause"))).status).toBe(200);
  expect((await handle(req("POST", "/v1/resume", {}))).status).toBe(200);
  expect(pauseCalls).toEqual(["pause:user", "resume:user"]);
});

test.each(["/v1/pause", "/v1/resume"])("%s rejects a bad reason with 400", async (path) => {
  const { handle, pauseCalls } = setup();
  for (const reason of ["Mic", "1mic", "", "a".repeat(33), 7]) {
    const res = await handle(req("POST", path, { reason }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("reason");
  }
  expect(pauseCalls).toEqual([]);
});

test.each([
  ["GET", "/v1/status"],
  ["POST", "/v1/pause"],
  ["POST", "/v1/resume"],
])("%s %s requires auth", async (method, path) => {
  const { handle, pauseCalls } = setup();
  expect((await handle(req(method, path, undefined, null))).status).toBe(401);
  expect((await handle(req(method, path, undefined, "wrong"))).status).toBe(401);
  expect(pauseCalls).toEqual([]);
});

test("status and pause reject the wrong method", async () => {
  const { handle } = setup();
  const res = await handle(req("POST", "/v1/status"));
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("GET");
  expect((await handle(req("GET", "/v1/pause"))).status).toBe(405);
});
