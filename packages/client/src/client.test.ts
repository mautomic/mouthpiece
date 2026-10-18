import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dismissInbox,
  getMode,
  getSettings,
  health,
  interrupt,
  MouthpieceError,
  pause,
  REPLY_TIMEOUT_MS,
  replay,
  reply,
  resume,
  setMode,
  shutdown,
  speak,
  status,
  updateSettings,
  usage,
  voices,
} from "./index.ts";

const seen: {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  body: string;
}[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;
let url: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-client-"));
  await writeFile(join(home, "token"), "filetoken\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname: path, search } = new URL(req.url);
      seen.push({
        method: req.method,
        path,
        search,
        auth: req.headers.get("authorization"),
        body: await req.text(),
      });
      if (path === "/v1/slow") await Bun.sleep(500);
      if (path === "/v1/health")
        return Response.json({ ok: true, version: "0.1.0", provider: "say", queueDepth: 0 });
      if (path === "/v1/interrupt")
        return Response.json({ error: "source must match" }, { status: 400 });
      return Response.json({ id: "x" }, { status: 202 });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

test("speak sends the event with the token from MOUTHPIECE_HOME", async () => {
  expect(
    await speak({ text: "hi", source: "cli" }, { url, env: { MOUTHPIECE_HOME: home } }),
  ).toEqual({ id: "x" });
  const last = seen.at(-1);
  expect(last?.auth).toBe("Bearer filetoken");
  expect(JSON.parse(last?.body ?? "")).toEqual({ text: "hi", source: "cli" });
});

test("explicit and env tokens take precedence over the file", async () => {
  await speak(
    { text: "hi", source: "cli" },
    { url, env: { MOUTHPIECE_HOME: home, MOUTHPIECE_TOKEN: "envtoken" } },
  );
  expect(seen.at(-1)?.auth).toBe("Bearer envtoken");
  await speak(
    { text: "hi", source: "cli" },
    { url, token: "argtoken", env: { MOUTHPIECE_TOKEN: "envtoken" } },
  );
  expect(seen.at(-1)?.auth).toBe("Bearer argtoken");
});

test("error bodies become MouthpieceError with status", async () => {
  const p = interrupt({ source: "cli" }, { url, token: "t" });
  await expect(p).rejects.toBeInstanceOf(MouthpieceError);
  await expect(p).rejects.toThrow("source must match");
});

test("health works", async () => {
  // Explicit token: never fall back to reading the real ~/.mouthpiece in tests.
  expect((await health({ url, token: "t" })).provider).toBe("say");
});

test("unreachable daemon is a MouthpieceError", async () => {
  await expect(
    speak({ text: "hi", source: "cli" }, { url: "http://127.0.0.1:1", token: "t" }),
  ).rejects.toThrow("unreachable");
});

test("timeoutMs bounds the call", async () => {
  const started = performance.now();
  await expect(
    speak({ text: "hi", source: "cli" }, { url: `${url}/v1/slow#`, token: "t", timeoutMs: 100 }),
  ).rejects.toBeInstanceOf(MouthpieceError);
  expect(performance.now() - started).toBeLessThan(400);
});

test("getMode is GET /v1/mode", async () => {
  await getMode({ url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/mode", body: "" });
});

test("setMode is POST /v1/mode with the request body", async () => {
  await setMode({ mode: "full", source: "cli" }, { url, token: "t" });
  const last = seen.at(-1);
  expect(last).toMatchObject({ method: "POST", path: "/v1/mode" });
  expect(JSON.parse(last?.body ?? "")).toEqual({ mode: "full", source: "cli" });
});

test("replay is POST /v1/replay and defaults to an empty body object", async () => {
  await replay(undefined, { url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/replay", body: "{}" });
  await replay({ full: true }, { url, token: "t" });
  expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({ full: true });
});

test("usage is GET /v1/usage with an optional month", async () => {
  await usage({ url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/usage", search: "", body: "" });
  await usage({ url, token: "t", month: "2026-10" });
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/usage", search: "?month=2026-10" });
});

test("voices is GET /v1/voices with an optional provider", async () => {
  await voices({ url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/voices", search: "", body: "" });
  await voices({ url, token: "t", provider: "say" });
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/voices", search: "?provider=say" });
});

test("status is GET /v1/status", async () => {
  await status({ url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/status", body: "" });
});

test("pause and resume POST the reason, defaulting to user", async () => {
  await pause(undefined, { url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/pause", auth: "Bearer t" });
  expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({ reason: "user" });
  await pause("mic", { url, token: "t" });
  expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({ reason: "mic" });
  await resume(undefined, { url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/resume" });
  expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({ reason: "user" });
  await resume("mic", { url, token: "t" });
  expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({ reason: "mic" });
});

test("settings are GET and POST /v1/settings", async () => {
  await getSettings({ url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/settings", body: "" });
  await updateSettings({ kokoro: { speed: 1.3 } }, { url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/settings", auth: "Bearer t" });
  expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({ kokoro: { speed: 1.3 } });
});

test("shutdown is POST /v1/shutdown", async () => {
  await shutdown({ url, token: "t" });
  expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/shutdown", auth: "Bearer t" });
});

test("a refused reply raises MouthpieceError with the status and reason", async () => {
  const fetchFake = (async () =>
    new Response(JSON.stringify({ error: "the prompt is not empty", reason: "draft" }), {
      status: 409,
    })) as unknown as typeof fetch;
  const error = await reply(
    { id: "e1", text: "go" },
    { url: "http://x", token: "t", fetch: fetchFake },
  ).catch((e) => e);
  expect(error).toBeInstanceOf(MouthpieceError);
  expect([error.status, error.reason, error.message]).toEqual([
    409,
    "draft",
    "the prompt is not empty",
  ]);
});

test("reply waits up to REPLY_TIMEOUT_MS by default", () => {
  expect(REPLY_TIMEOUT_MS).toBe(25_000);
});

test("dismissInbox posts the id to /v1/inbox/dismiss", async () => {
  let seenBody = "";
  let seenPath = "";
  const fetchFake = (async (url: string, init: RequestInit) => {
    seenPath = new URL(url).pathname;
    seenBody = String(init.body);
    return new Response(JSON.stringify({ dismissed: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  expect(
    await dismissInbox({ id: "e1" }, { url: "http://x", token: "t", fetch: fetchFake }),
  ).toEqual({
    dismissed: 1,
  });
  expect([seenPath, seenBody]).toEqual(["/v1/inbox/dismiss", '{"id":"e1"}']);
});
