import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultExec, type Exec } from "@mouthpiece/core";

/** Swift source of the helper app: global hotkeys, menubar status item, mic watcher. */
export const HELPER_SOURCE = join(import.meta.dir, "MouthpieceHelper.swift");
/** @deprecated Phase 2 name; use HELPER_SOURCE. */
export const HOTKEYS_SOURCE = HELPER_SOURCE;

export const HELPER_BUNDLE_ID = "dev.mouthpiece.helper";
export const HELPER_EXECUTABLE = "mouthpiece-helper";
const HELPER_NAME = "MouthpieceHelper";

export function helperAppPath(home: string): string {
  return join(home, `${HELPER_NAME}.app`);
}

/** The executable inside the bundle. Launching it directly keeps a process handle for the supervisor. */
export function helperBinary(home: string): string {
  return join(helperAppPath(home), "Contents", "MacOS", HELPER_EXECUTABLE);
}

/** @deprecated Phase 2 name; use helperBinary. */
export const hotkeysBinary = helperBinary;

/** LSUIElement: no Dock icon or app menu; the bundle gives the menubar item an identity (macOS 26). */
export function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${HELPER_BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>
  <string>${HELPER_EXECUTABLE}</string>
  <key>CFBundleName</key>
  <string>${HELPER_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.4.0</string>
  <key>CFBundleVersion</key>
  <string>4</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

/** Builds `<home>/MouthpieceHelper.app`: Info.plist, swiftc, then an ad-hoc signature. Returns the app path. */
export async function buildHelper(opts: {
  home: string;
  exec?: Exec;
  swiftc?: string;
}): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const app = helperAppPath(opts.home);
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), infoPlist());
  const compile = await exec([
    opts.swiftc ?? "swiftc",
    "-O",
    "-swift-version",
    "5",
    "-o",
    helperBinary(opts.home),
    HELPER_SOURCE,
  ]);
  if (compile.code !== 0)
    throw new Error(`swiftc failed (${compile.code}): ${compile.stderr.trim()}`);
  const sign = await exec(["codesign", "-f", "-s", "-", "--identifier", HELPER_BUNDLE_ID, app]);
  if (sign.code !== 0) throw new Error(`codesign failed (${sign.code}): ${sign.stderr.trim()}`);
  return app;
}
