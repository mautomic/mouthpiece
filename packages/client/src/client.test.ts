import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { health, interrupt, MouthpieceError, speak } from "./index.ts";

const seen: { path: string; auth: string | null; body: string }[] = [];
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
      const path = new URL(req.url).pathname;
      seen.push({ path, auth: req.headers.get("authorization"), body: await req.text() });
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
