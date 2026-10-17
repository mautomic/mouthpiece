import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultExec, type Exec } from "@mouthpiece/core";

export const HOTKEYS_SOURCE = join(import.meta.dir, "MouthpieceHotkeys.swift");

export function hotkeysBinary(home: string): string {
  return join(home, "bin", "mouthpiece-hotkeys");
}

export async function buildHotkeys(opts: {
  out: string;
  exec?: Exec;
  swiftc?: string;
}): Promise<void> {
  await mkdir(dirname(opts.out), { recursive: true });
  const r = await (opts.exec ?? defaultExec)([
    opts.swiftc ?? "swiftc",
    "-O",
    "-swift-version",
    "5",
    "-o",
    opts.out,
    HOTKEYS_SOURCE,
  ]);
  if (r.code !== 0) throw new Error(`swiftc failed (${r.code}): ${r.stderr.trim()}`);
}
