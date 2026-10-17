import { expect, test } from "bun:test";
import type { Exec } from "@mouthpiece/core";
import { buildHotkeys, HOTKEYS_SOURCE, hotkeysBinary } from "./build.ts";

test("invokes swiftc with the source and output", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  };
  await buildHotkeys({ out: "/tmp/mp-hk-test/bin/mouthpiece-hotkeys", exec });
  expect(calls[0]).toEqual([
    "swiftc",
    "-O",
    "-swift-version",
    "5",
    "-o",
    "/tmp/mp-hk-test/bin/mouthpiece-hotkeys",
    HOTKEYS_SOURCE,
  ]);
  expect(hotkeysBinary("/h")).toBe("/h/bin/mouthpiece-hotkeys");
});

test("compile failure surfaces stderr", async () => {
  const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "error: boom" });
  await expect(buildHotkeys({ out: "/tmp/mp-hk-test/x", exec })).rejects.toThrow("boom");
});

const hasSwift = process.platform === "darwin" && Bun.which("swiftc") !== null;
test.skipIf(!hasSwift)(
  "Swift helper typechecks",
  async () => {
    const proc = Bun.spawn(["swiftc", "-typecheck", "-swift-version", "5", HOTKEYS_SOURCE], {
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  },
  120_000,
);
