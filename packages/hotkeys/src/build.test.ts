import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@mouthpiece/core";
import {
  buildHelper,
  HELPER_BUNDLE_ID,
  HELPER_SOURCE,
  HOTKEYS_SOURCE,
  helperAppPath,
  helperBinary,
  hotkeysBinary,
  infoPlist,
} from "./build.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-helper-build-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function recordingExec(fail?: { at: number; stderr: string }) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    if (fail && calls.length - 1 === fail.at) return { code: 1, stdout: "", stderr: fail.stderr };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

test("paths: the helper is an app bundle in the home dir", () => {
  expect(helperAppPath("/h")).toBe("/h/MouthpieceHelper.app");
  expect(helperBinary("/h")).toBe("/h/MouthpieceHelper.app/Contents/MacOS/mouthpiece-helper");
  expect(hotkeysBinary("/h")).toBe(helperBinary("/h"));
  expect(HOTKEYS_SOURCE).toBe(HELPER_SOURCE);
  expect(HELPER_SOURCE.endsWith("MouthpieceHelper.swift")).toBe(true);
  expect(existsSync(HELPER_SOURCE)).toBe(true);
});

test("infoPlist is an LSUIElement app with the helper's identity", () => {
  const plist = infoPlist();
  expect(plist).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
  const entry = (key: string) =>
    new RegExp(`<key>${key}</key>\\s*<(string>([^<]*)</string|true/|false/)>`).exec(plist)?.[0];
  expect(entry("CFBundleIdentifier")).toContain(`<string>${HELPER_BUNDLE_ID}</string>`);
  expect(HELPER_BUNDLE_ID).toBe("dev.mouthpiece.helper");
  expect(entry("CFBundleExecutable")).toContain("<string>mouthpiece-helper</string>");
  expect(entry("CFBundlePackageType")).toContain("<string>APPL</string>");
  expect(entry("CFBundleName")).toContain("<string>MouthpieceHelper</string>");
  expect(entry("LSUIElement")).toContain("<true/>");
});

test("buildHelper writes the plist, compiles, then ad-hoc signs with the bundle id", async () => {
  const { calls, exec } = recordingExec();
  const app = await buildHelper({ home, exec });
  expect(app).toBe(helperAppPath(home));
  expect(await readFile(join(app, "Contents", "Info.plist"), "utf8")).toBe(infoPlist());
  expect((await stat(join(app, "Contents", "MacOS"))).isDirectory()).toBe(true);
  expect(calls).toEqual([
    ["swiftc", "-O", "-swift-version", "5", "-o", helperBinary(home), HELPER_SOURCE],
    ["codesign", "-f", "-s", "-", "--identifier", "dev.mouthpiece.helper", app],
  ]);
});

test("buildHelper honors a custom swiftc", async () => {
  const { calls, exec } = recordingExec();
  await buildHelper({ home, exec, swiftc: "/opt/swiftc" });
  expect(calls[0]?.[0]).toBe("/opt/swiftc");
});

test("compile failure surfaces stderr and skips codesign", async () => {
  const { calls, exec } = recordingExec({ at: 0, stderr: "error: boom" });
  await expect(buildHelper({ home, exec })).rejects.toThrow("boom");
  expect(calls).toHaveLength(1);
});

test("codesign failure surfaces stderr", async () => {
  const { exec } = recordingExec({ at: 1, stderr: "errSecInternal" });
  await expect(buildHelper({ home, exec })).rejects.toThrow(/codesign failed.*errSecInternal/);
});

const hasSwift = process.platform === "darwin" && Bun.which("swiftc") !== null;
test.skipIf(!hasSwift)(
  "Swift helper typechecks",
  async () => {
    const proc = Bun.spawn(["swiftc", "-typecheck", "-swift-version", "5", HELPER_SOURCE], {
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  },
  120_000,
);

// Full build into a temp dir to check the bundle layout. Never launches the result.
const fullBuild =
  hasSwift && Bun.which("codesign") !== null && !!process.env.MOUTHPIECE_HELPER_BUILD;
test.skipIf(!fullBuild)(
  "full build produces a signed bundle (MOUTHPIECE_HELPER_BUILD=1)",
  async () => {
    const app = await buildHelper({ home });
    expect(app.startsWith(home)).toBe(true);
    expect((await stat(helperBinary(home))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(app, "Contents", "Info.plist"), "utf8")).toBe(infoPlist());
    const verify = Bun.spawn(["codesign", "-dv", app], { stderr: "pipe" });
    expect(await verify.exited).toBe(0);
    expect(await new Response(verify.stderr).text()).toContain("Identifier=dev.mouthpiece.helper");
  },
  300_000,
);
