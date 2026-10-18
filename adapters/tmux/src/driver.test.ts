import { expect, test } from "bun:test";
import type { ConversationDriver, Exec, ExecResult } from "@mouthpiece/core";
import { isTmuxAvailable, TmuxDriver } from "./driver.ts";

function fakeExec(results: Partial<ExecResult>[] = []) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "", ...results[calls.length - 1] };
  };
  return { exec, calls };
}

test("implements ConversationDriver with a configurable source", () => {
  const driver: ConversationDriver = new TmuxDriver({ exec: fakeExec().exec });
  expect(driver.source).toBe("claude-code");
  expect(new TmuxDriver({ source: "codex", exec: fakeExec().exec }).source).toBe("codex");
});

test("types the text literally, then presses Enter", async () => {
  const { exec, calls } = fakeExec();
  await new TmuxDriver({ exec }).send("cc:0.1", "run the tests");
  expect(calls).toEqual([
    ["tmux", "send-keys", "-t", "cc:0.1", "-l", "--", "run the tests"],
    ["tmux", "send-keys", "-t", "cc:0.1", "Enter"],
  ]);
});

test("newlines become spaces, so the prompt is submitted once", async () => {
  const { exec, calls } = fakeExec();
  await new TmuxDriver({ exec }).send("cc", "  first line\nsecond\r\nthird  ");
  expect(calls[0]?.at(-1)).toBe("first line second third");
});

test("text that looks like a flag is passed after --", async () => {
  const { exec, calls } = fakeExec();
  await new TmuxDriver({ exec }).send("cc", "-n is the flag");
  expect(calls[0]?.slice(-2)).toEqual(["--", "-n is the flag"]);
});

test("a trailing semicolon is escaped so tmux does not treat it as a command separator", async () => {
  const { exec, calls } = fakeExec();
  await new TmuxDriver({ exec }).send("cc", "do this; then that;");
  expect(calls[0]?.at(-1)).toBe("do this; then that\\;");
});

test.each([["%3"], ["$1"], ["cc"], ["my-session:2.0"], ["work_1:editor.1"]])(
  "accepts target %s",
  async (target) => {
    const { exec, calls } = fakeExec();
    await new TmuxDriver({ exec }).send(target, "hi");
    expect(calls).toHaveLength(2);
  },
);

test.each([[""], ["cc; kill-server"], ["a b"], ["cc\n"], ["$(rm)"]])(
  "rejects target %p without running tmux",
  async (target) => {
    const { exec, calls } = fakeExec();
    await expect(new TmuxDriver({ exec }).send(target, "hi")).rejects.toThrow("tmux target");
    expect(calls).toEqual([]);
  },
);

test.each([[""], ["   "], ["\n\n"]])("rejects empty text %p", async (text) => {
  const { exec, calls } = fakeExec();
  await expect(new TmuxDriver({ exec }).send("cc", text)).rejects.toThrow("empty");
  expect(calls).toEqual([]);
});

test("a failing send-keys throws with stderr and does not press Enter", async () => {
  const { exec, calls } = fakeExec([{ code: 1, stderr: "can't find pane: cc\n" }]);
  await expect(new TmuxDriver({ exec }).send("cc", "hi")).rejects.toThrow("can't find pane: cc");
  expect(calls).toHaveLength(1);
});

test("a failing Enter also throws", async () => {
  const { exec } = fakeExec([{}, { code: 1, stderr: "no server running" }]);
  await expect(new TmuxDriver({ exec }).send("cc", "hi")).rejects.toThrow("no server running");
});

test("a custom tmux binary is used for every call", async () => {
  const { exec, calls } = fakeExec();
  await new TmuxDriver({ exec, tmux: "/opt/homebrew/bin/tmux" }).send("cc", "hi");
  expect(calls.map((c) => c[0])).toEqual(["/opt/homebrew/bin/tmux", "/opt/homebrew/bin/tmux"]);
});

test("isTmuxAvailable runs tmux -V", async () => {
  const ok = fakeExec([{ stdout: "tmux 3.5a\n" }]);
  expect(await isTmuxAvailable(ok.exec)).toBe(true);
  expect(ok.calls).toEqual([["tmux", "-V"]]);
  expect(await isTmuxAvailable(fakeExec([{ code: 127, stderr: "not found" }]).exec)).toBe(false);
});

test("isTmuxAvailable treats a throwing exec as missing", async () => {
  const exec: Exec = async () => {
    throw new Error("ENOENT");
  };
  expect(await isTmuxAvailable(exec)).toBe(false);
});
