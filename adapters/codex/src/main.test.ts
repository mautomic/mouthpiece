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
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    ms: performance.now() - started,
  };
}

const input = JSON.stringify({
  session_id: "s1",
  cwd: "/x/api",
  hook_event_name: "Stop",
  turn_id: "t1",
  model: "gpt-5-codex",
  transcript_path: null,
  last_assistant_message: "Hello from the codex hook test.",
});
const silent = { code: 0, stdout: "", stderr: "" };

test("main is silent and exits 0 on bad stdin, a dead daemon, and a hanging daemon", async () => {
  const dead = { MOUTHPIECE_URL: "http://127.0.0.1:1" };
  for (const r of [
    await runHook("stop", "{nope", dead),
    await runHook("stop", "", dead),
    await runHook("stop", input, dead),
    await runHook("prompt", input, dead),
    await runHook("permission", input, dead),
  ]) {
    expect(r).toMatchObject(silent);
    expect(r.ms).toBeLessThan(1500);
  }
  const hung = await runHook("stop", input, {
    MOUTHPIECE_URL: `http://127.0.0.1:${hanging.port}`,
  });
  expect(hung).toMatchObject(silent);
  expect(hung.ms).toBeLessThan(1500);
}, 15_000);

test("posts the event", async () => {
  const r = await runHook("stop", input, { MOUTHPIECE_URL: `http://127.0.0.1:${recording.port}` });
  expect(r).toMatchObject(silent);
  expect(received.at(-1)).toStartWith("/v1/speak ");
  expect(received.at(-1)).toContain('"source":"codex"');
  await runHook("prompt", input, { MOUTHPIECE_URL: `http://127.0.0.1:${recording.port}` });
  expect(received.at(-1)).toStartWith("/v1/interrupt ");
});

test("MOUTHPIECE_CHILD=1 sends nothing", async () => {
  const before = received.length;
  const r = await runHook("stop", input, {
    MOUTHPIECE_URL: `http://127.0.0.1:${recording.port}`,
    MOUTHPIECE_CHILD: "1",
  });
  expect(r).toMatchObject(silent);
  expect(received.length).toBe(before);
});
