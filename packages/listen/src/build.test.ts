import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@mouthpiece/core";
import {
  buildListen,
  LISTEN_BUNDLE_ID,
  LISTEN_PLIST,
  LISTEN_SOURCE,
  listenAppPath,
  listenBinary,
} from "./build.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-listen-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function plistValue(xml: string, key: string): string | undefined {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`));
  if (!m) return undefined;
  return m[1] === "string" ? m[2] : m[1];
}

test("Info.plist names the bundle and carries both usage descriptions", async () => {
  const xml = await readFile(LISTEN_PLIST, "utf8");
  expect(plistValue(xml, "CFBundleIdentifier")).toBe(LISTEN_BUNDLE_ID);
  expect(plistValue(xml, "CFBundleExecutable")).toBe("mouthpiece-listen");
  expect(plistValue(xml, "CFBundlePackageType")).toBe("APPL");
  expect(plistValue(xml, "LSUIElement")).toBe("true");
  expect(plistValue(xml, "NSMicrophoneUsageDescription")?.length).toBeGreaterThan(10);
  expect(plistValue(xml, "NSSpeechRecognitionUsageDescription")?.length).toBeGreaterThan(10);
});

test("paths: the app lands in the chosen output dir", () => {
  expect(listenAppPath("/out")).toBe("/out/MouthpieceListen.app");
  expect(listenBinary("/out")).toBe("/out/MouthpieceListen.app/Contents/MacOS/mouthpiece-listen");
});

test("build writes the plist, compiles, then ad-hoc signs the bundle", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  };
  const app = await buildListen({ outDir: dir, exec });
  expect(app).toBe(listenAppPath(dir));
  expect(calls).toEqual([
    ["swiftc", "-O", "-swift-version", "5", "-o", listenBinary(dir), LISTEN_SOURCE],
    ["codesign", "-f", "-s", "-", "--identifier", LISTEN_BUNDLE_ID, app],
  ]);
  expect(await readFile(join(app, "Contents", "Info.plist"), "utf8")).toBe(
    await readFile(LISTEN_PLIST, "utf8"),
  );
  expect(existsSync(join(app, "Contents", "MacOS"))).toBe(true);
});

test("a custom swiftc is used", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  };
  await buildListen({ outDir: dir, exec, swiftc: "/x/swiftc" });
  expect(calls[0]?.[0]).toBe("/x/swiftc");
});

test("a compile failure throws with stderr and never signs", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    return { code: 1, stdout: "", stderr: "error: boom" };
  };
  await expect(buildListen({ outDir: dir, exec })).rejects.toThrow("boom");
  expect(calls).toHaveLength(1);
});

test("a signing failure throws with stderr", async () => {
  let n = 0;
  const exec: Exec = async () =>
    ++n === 2
      ? { code: 1, stdout: "", stderr: "codesign: nope" }
      : { code: 0, stdout: "", stderr: "" };
  await expect(buildListen({ outDir: dir, exec })).rejects.toThrow("codesign: nope");
});

const hasSwift = process.platform === "darwin" && Bun.which("swiftc") !== null;

// Typecheck only: never build-and-run here, since running it asks for mic and speech permission.
test.skipIf(!hasSwift)(
  "Swift prototype typechecks",
  async () => {
    const proc = Bun.spawn(["swiftc", "-typecheck", "-swift-version", "5", LISTEN_SOURCE], {
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  },
  120_000,
);

const hasPlutil = process.platform === "darwin" && Bun.which("plutil") !== null;
test.skipIf(!hasPlutil)("Info.plist is valid", async () => {
  const proc = Bun.spawn(["plutil", "-lint", LISTEN_PLIST], { stdout: "pipe" });
  expect(await proc.exited).toBe(0);
});

// Opt-in full build into a temp dir (slow). Asserts the bundle layout; the result is never launched.
const fullBuild = hasSwift && Bun.which("codesign") !== null && process.env.MOUTHPIECE_SWIFT_BUILD;
test.skipIf(!fullBuild)(
  "full build produces a signed bundle (not launched)",
  async () => {
    const app = await buildListen({ outDir: dir });
    expect(existsSync(listenBinary(dir))).toBe(true);
    const verify = Bun.spawn(["codesign", "--verify", "--strict", app], { stderr: "pipe" });
    if ((await verify.exited) !== 0) throw new Error(await new Response(verify.stderr).text());
  },
  300_000,
);
