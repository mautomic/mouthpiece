import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { type HookContext, runHook } from "./run.ts";

function harness(stdinText = "{}") {
  const codes: number[] = [];
  let reads = 0;
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const exit = ((code: number) => {
    codes.push(code);
    resolveExit(code);
  }) as (code: number) => never;
  const stdin = async () => {
    reads++;
    return stdinText;
  };
  return { codes, exit, stdin, exited, reads: () => reads };
}

test("calls the handler with argv[2], the parsed input and a context, then exits 0", async () => {
  const h = harness('{"session_id":"s1"}');
  const calls: [string, unknown, HookContext][] = [];
  await runHook(
    async (event, input, ctx) => {
      calls.push([event, input, ctx]);
    },
    { argv: ["bun", "main.ts", "stop"], env: { X: "1" }, stdin: h.stdin, exit: h.exit },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("stop");
  expect(calls[0]?.[1]).toEqual({ session_id: "s1" });
  expect(calls[0]?.[2].env).toEqual({ X: "1" });
  expect(h.codes).toEqual([0]);
});

test("a missing event argument becomes an empty string", async () => {
  const h = harness();
  const events: string[] = [];
  await runHook(
    async (event) => {
      events.push(event);
    },
    { argv: ["bun"], env: {}, stdin: h.stdin, exit: h.exit },
  );
  expect(events).toEqual([""]);
});

test("a handler that throws still exits 0", async () => {
  const h = harness();
  await runHook(
    async () => {
      throw new Error("boom");
    },
    { argv: ["bun", "m", "stop"], env: {}, stdin: h.stdin, exit: h.exit },
  );
  expect(h.codes).toEqual([0]);
});

test("a stdin reader that throws exits 0 without calling the handler", async () => {
  const h = harness();
  let called = false;
  await runHook(
    async () => {
      called = true;
    },
    {
      argv: ["bun", "m", "stop"],
      env: {},
      stdin: async () => {
        throw new Error("EPIPE");
      },
      exit: h.exit,
    },
  );
  expect(called).toBe(false);
  expect(h.codes).toEqual([0]);
});

test.each([["{nope"], [""], ["x".repeat(10)]])(
  "invalid JSON %# never calls the handler and exits 0",
  async (text) => {
    const h = harness(text);
    let called = false;
    await runHook(
      async () => {
        called = true;
      },
      { argv: ["bun", "m", "stop"], env: {}, stdin: h.stdin, exit: h.exit },
    );
    expect(called).toBe(false);
    expect(h.codes).toEqual([0]);
  },
);

test("input over 1 MB is ignored", async () => {
  const h = harness(JSON.stringify({ text: "x".repeat(1024 * 1024) }));
  let called = false;
  await runHook(
    async () => {
      called = true;
    },
    { argv: ["bun", "m", "stop"], env: {}, stdin: h.stdin, exit: h.exit },
  );
  expect(called).toBe(false);
  expect(h.codes).toEqual([0]);
});

test("MOUTHPIECE_CHILD=1 never reads stdin and exits 0", async () => {
  const h = harness();
  let called = false;
  await runHook(
    async () => {
      called = true;
    },
    { argv: ["bun", "m", "stop"], env: { MOUTHPIECE_CHILD: "1" }, stdin: h.stdin, exit: h.exit },
  );
  expect(h.reads()).toBe(0);
  expect(called).toBe(false);
  expect(h.codes).toEqual([0]);
});

test("the hard exit fires when the handler hangs", async () => {
  const h = harness();
  const started = performance.now();
  void runHook(() => new Promise<void>(() => {}), {
    argv: ["bun", "m", "stop"],
    env: {},
    stdin: h.stdin,
    exit: h.exit,
    hardExitMs: 50,
  });
  expect(await h.exited).toBe(0);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(h.codes).toEqual([0]);
});

let hanging: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  hanging = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
});
afterAll(() => {
  hanging.stop(true);
});

test("ctx.speak and ctx.interrupt give up after clientTimeoutMs", async () => {
  const h = harness();
  const outcomes: string[] = [];
  const started = performance.now();
  await runHook(
    async (_event, _input, ctx) => {
      await ctx.speak({ text: "hi", source: "test" }).catch(() => outcomes.push("speak failed"));
      await ctx.interrupt({ source: "test" }).catch(() => outcomes.push("interrupt failed"));
    },
    {
      argv: ["bun", "m", "stop"],
      env: { MOUTHPIECE_URL: `http://127.0.0.1:${hanging.port}`, MOUTHPIECE_TOKEN: "t" },
      stdin: h.stdin,
      exit: h.exit,
      clientTimeoutMs: 50,
      hardExitMs: 5000,
    },
  );
  expect(outcomes).toEqual(["speak failed", "interrupt failed"]);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(h.codes).toEqual([0]);
});

test("ctx.readFile reads text files", async () => {
  const h = harness();
  let content = "";
  await runHook(
    async (_e, _i, ctx) => {
      content = await ctx.readFile(join(import.meta.dir, "..", "package.json"));
    },
    { argv: ["bun", "m", "stop"], env: {}, stdin: h.stdin, exit: h.exit },
  );
  expect(content).toContain("@mouthpiece/hook-kit");
});

const FIXTURE = join(import.meta.dir, "fixture-main.ts");

async function spawnFixture(input: string, env: Record<string, string>) {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, FIXTURE, "stop"], {
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

test("a real hook process is silent and exits 0 against a dead daemon", async () => {
  const r = await spawnFixture("{}", { MOUTHPIECE_URL: "http://127.0.0.1:1" });
  expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
});

test("a real hook process is silent and exits 0 on garbage stdin and a hanging daemon", async () => {
  const garbage = await spawnFixture("{nope", { MOUTHPIECE_URL: "http://127.0.0.1:1" });
  expect(garbage).toMatchObject({ code: 0, stdout: "", stderr: "" });
  const hung = await spawnFixture("{}", { MOUTHPIECE_URL: `http://127.0.0.1:${hanging.port}` });
  expect(hung).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(hung.ms).toBeLessThan(1500);
});
