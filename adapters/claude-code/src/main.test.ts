import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "main.ts");
const received: string[] = [];
let hanging: ReturnType<typeof Bun.serve>;
let recording: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  hanging = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  recording = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      received.push(`${new URL(req.url).pathname} ${await req.text()}`);
      return Response.json({ id: "x" }, { status: 202 });
    },
  });
});
afterAll(() => {
  hanging.stop(true);
  recording.stop(true);
});

async function runHook(event: string, input: string, env: Record<string, string>) {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, MAIN, event], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", MOUTHPIECE_TOKEN: "t", ...env },
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), ms: performance.now() - started };
}

const input = JSON.stringify({
  session_id: "s1",
  cwd: "/x/web",
  last_assistant_message: "Hello from the hook test.",
});

test("returns fast and silent when the daemon hangs", async () => {
  const r = await runHook("stop", input, { MOUTHPIECE_URL: `http://127.0.0.1:${hanging.port}` });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.ms).toBeLessThan(1500);
});

test("exits 0 silently when the daemon is down or stdin is garbage", async () => {
  expect(await runHook("stop", input, { MOUTHPIECE_URL: "http://127.0.0.1:1" })).toMatchObject({
    code: 0,
    stdout: "",
  });
  expect(await runHook("stop", "{nope", { MOUTHPIECE_URL: "http://127.0.0.1:1" })).toMatchObject({
    code: 0,
    stdout: "",
  });
});

test("posts the event to the daemon", async () => {
  await runHook("stop", input, { MOUTHPIECE_URL: `http://127.0.0.1:${recording.port}` });
  expect(received.at(-1)).toStartWith("/v1/speak ");
  expect(received.at(-1)).toContain('"source":"claude-code"');
});

test("MOUTHPIECE_CHILD=1 sends nothing", async () => {
  const before = received.length;
  await runHook("stop", input, {
    MOUTHPIECE_URL: `http://127.0.0.1:${recording.port}`,
    MOUTHPIECE_CHILD: "1",
  });
  expect(received.length).toBe(before);
});
