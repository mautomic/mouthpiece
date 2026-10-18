import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultExec, type Exec } from "@mouthpiece/core";

/** Swift source of the helper app: global hotkeys, menubar status item, mic watcher. */
/** The helper's entry file (top-level code, the key-code table). */
export const HELPER_SOURCE = join(import.meta.dir, "helper", "main.swift");
/** Every helper source, compiled together; only main.swift has top-level code. */
export const HELPER_SOURCES: readonly string[] = [
  HELPER_SOURCE,
  join(import.meta.dir, "helper", "InboxCore.swift"),
  join(import.meta.dir, "helper", "InboxViewModel.swift"),
  join(import.meta.dir, "helper", "InboxView.swift"),
  join(import.meta.dir, "helper", "InboxPanel.swift"),
];
/** @deprecated Phase 2 name; use HELPER_SOURCE. */
export const HOTKEYS_SOURCE = HELPER_SOURCE;

export const HELPER_BUNDLE_ID = "dev.mouthpiece.helper";
export const HELPER_EXECUTABLE = "mouthpiece-helper";
/** Swift source of the gap-free audio player the daemon plays through (US-005). */
export const PLAYER_SOURCE = join(import.meta.dir, "MouthpiecePlayer.swift");
export const PLAYER_EXECUTABLE = "mouthpiece-player";
export const PLAYER_IDENTIFIER = "dev.mouthpiece.player";
const HELPER_NAME = "MouthpieceHelper";

export function helperAppPath(home: string): string {
  return join(home, `${HELPER_NAME}.app`);
}

/** The executable inside the bundle. Launching it directly keeps a process handle for the supervisor. */
export function helperBinary(home: string): string {
  return join(helperAppPath(home), "Contents", "MacOS", HELPER_EXECUTABLE);
}

/** The gap-free player, a second executable in the helper bundle. */
export function playerBinary(home: string): string {
  return join(helperAppPath(home), "Contents", "MacOS", PLAYER_EXECUTABLE);
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

/** Builds <home>/MouthpieceHelper.app: Info.plist, the helper and the player (swiftc), then ad-hoc signatures. Returns the app path. */
export async function buildHelper(opts: {
  home: string;
  exec?: Exec;
  swiftc?: string;
}): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const app = helperAppPath(opts.home);
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), infoPlist());
  const targets: [readonly string[], string][] = [
    [HELPER_SOURCES, helperBinary(opts.home)],
    [[PLAYER_SOURCE], playerBinary(opts.home)],
  ];
  for (const [sources, binary] of targets) {
    const compile = await exec([
      opts.swiftc ?? "swiftc",
      "-O",
      "-swift-version",
      "5",
      "-o",
      binary,
      ...sources,
    ]);
    if (compile.code !== 0)
      throw new Error(`swiftc failed (${compile.code}): ${compile.stderr.trim()}`);
  }
  // The bundle's seal covers the other executable, so it is signed first.
  for (const [identifier, path] of [
    [PLAYER_IDENTIFIER, playerBinary(opts.home)],
    [HELPER_BUNDLE_ID, app],
  ] as const) {
    const sign = await exec(["codesign", "-f", "-s", "-", "--identifier", identifier, path]);
    if (sign.code !== 0) throw new Error(`codesign failed (${sign.code}): ${sign.stderr.trim()}`);
  }
  return app;
}
