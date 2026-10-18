import { expect, test } from "bun:test";
import { defaultExec } from "./exec.ts";

test("captures stdout, stderr, exit code, and stdin", async () => {
  expect(
    await defaultExec(["/bin/sh", "-c", "cat; echo err >&2; exit 3"], { stdin: "hi" }),
  ).toEqual({
    code: 3,
    stdout: "hi",
    stderr: "err\n",
  });
});

test("missing command is code 127, not a throw", async () => {
  expect((await defaultExec(["/nonexistent/bin"])).code).toBe(127);
});

test("timeoutMs kills a command that runs too long", async () => {
  const started = performance.now();
  const r = await defaultExec(["sleep", "5"], { timeoutMs: 100 });
  expect(r.code).not.toBe(0);
  expect(performance.now() - started).toBeLessThan(3000);
});
