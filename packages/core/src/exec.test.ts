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
