import { expect, test } from "bun:test";
import type { NormalizedSpeakEvent } from "@mouthpiece/core";
import { createHandler, type HandlerDeps } from "./handler.ts";

const TOKEN = "t".repeat(64);

function setup(overrides: Partial<HandlerDeps> = {}) {
  const enqueued: NormalizedSpeakEvent[] = [];
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
    ...overrides,
  };
  return { handle: createHandler(deps), enqueued };
}

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
