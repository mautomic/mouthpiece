import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultExec, type Exec } from "@mouthpiece/core";

/**
 * Conversation-mode spike (PRD §12): builds the on-device speech-to-text prototype into an ad-hoc
 * signed `MouthpieceListen.app`. Not wired into the daemon or the installer.
 */
export const LISTEN_SOURCE = join(import.meta.dir, "MouthpieceListen.swift");
export const LISTEN_PLIST = join(import.meta.dir, "Info.plist");
export const LISTEN_BUNDLE_ID = "dev.mouthpiece.listen";

export function listenAppPath(outDir: string): string {
  return join(outDir, "MouthpieceListen.app");
}

export function listenBinary(outDir: string): string {
  return join(listenAppPath(outDir), "Contents", "MacOS", "mouthpiece-listen");
}

/**
 * 1. Copies Info.plist (the usage descriptions must sit in the bundle, or macOS kills the
 *    process when it asks for the mic or speech recognition).
 * 2. Compiles the Swift source into `Contents/MacOS`.
 * 3. Ad-hoc signs the bundle, which binds the plist to the code.
 * Returns the `.app` path.
 */
export async function buildListen(opts: {
  outDir: string;
  exec?: Exec;
  swiftc?: string;
}): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const app = listenAppPath(opts.outDir);
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await copyFile(LISTEN_PLIST, join(app, "Contents", "Info.plist"));
  const swiftc = opts.swiftc ?? "swiftc";
  const compiled = await exec([
    swiftc,
    "-O",
    "-swift-version",
    "5",
    "-o",
    listenBinary(opts.outDir),
    LISTEN_SOURCE,
  ]);
  if (compiled.code !== 0) {
    throw new Error(`swiftc failed (${compiled.code}): ${compiled.stderr.trim()}`);
  }
  const signed = await exec(["codesign", "-f", "-s", "-", "--identifier", LISTEN_BUNDLE_ID, app]);
  if (signed.code !== 0) {
    throw new Error(`codesign failed (${signed.code}): ${signed.stderr.trim()}`);
  }
  return app;
}

// `bun packages/listen/src/build.ts <outDir>` builds the app. It does not launch it.
if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: bun packages/listen/src/build.ts <outDir>");
    process.exit(2);
  }
  try {
    console.log(await buildListen({ outDir: resolve(outDir) }));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
