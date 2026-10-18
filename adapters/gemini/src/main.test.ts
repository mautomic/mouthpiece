// Gemini CLI treats any hook output as a message and a non-zero exit as a deny (which retries
// AfterAgent), so these tests require empty stdout AND stderr and exit 0 in every case.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "main.ts");
const received: string[] = [];
let hanging: ReturnType<typeof Bun.serve>;
let recording: ReturnType<typeof Bun.serve>;
let failing: ReturnType<typeof Bun.serve>;

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
  failing = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("not json", { status: 500 }),
  });
});
afterAll(() => {
  hanging.stop(true);
  recording.stop(true);
  failing.stop(true);
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
  session_id: "g1",
  cwd: "/x/site",
  transcript_path: "/tmp/none.jsonl",
  hook_event_name: "AfterAgent",
  timestamp: "2026-10-17T12:00:00.000Z",
  prompt: "hi",
  prompt_response: "Hello from the gemini hook test.",
});
const notify = JSON.stringify({
  session_id: "g1",
  cwd: "/x/site",
  hook_event_name: "Notification",
  notification_type: "ToolPermission",
  details: { toolName: "run_shell_command" },
});
const silent = { code: 0, stdout: "", stderr: "" };

test("gemini main is silent and exits 0 on bad stdin, a dead daemon, and a hanging daemon", async () => {
  const dead = { MOUTHPIECE_URL: "http://127.0.0.1:1" };
  const runs = [
    await runHook("stop", "{nope", dead),
    await runHook("stop", "", dead),
    await runHook("stop", "[1,2", dead),
    await runHook("stop", input, dead),
    await runHook("prompt", input, dead),
    await runHook("notify", notify, dead),
    await runHook("unknown-event", input, dead),
    await runHook("stop", input, { MOUTHPIECE_URL: `http://127.0.0.1:${failing.port}` }),
    await runHook("stop", input, { MOUTHPIECE_URL: "not a url" }),
    await runHook("stop", input, { MOUTHPIECE_URL: `http://127.0.0.1:${hanging.port}` }),
    await runHook("notify", notify, { MOUTHPIECE_URL: `http://127.0.0.1:${hanging.port}` }),
  ];
  for (const r of runs) {
    expect(r).toMatchObject(silent);
    expect(r.ms).toBeLessThan(1500);
  }
}, 20_000);

test("posts the event", async () => {
  const url = { MOUTHPIECE_URL: `http://127.0.0.1:${recording.port}` };
  expect(await runHook("stop", input, url)).toMatchObject(silent);
  expect(received.at(-1)).toStartWith("/v1/speak ");
  expect(received.at(-1)).toContain('"source":"gemini"');
  expect(await runHook("notify", notify, url)).toMatchObject(silent);
  expect(received.at(-1)).toContain("site needs your approval to use run_shell_command.");
  expect(await runHook("prompt", input, url)).toMatchObject(silent);
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
