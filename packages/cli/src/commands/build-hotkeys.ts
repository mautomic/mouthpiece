import { mouthpieceHome } from "@mouthpiece/core";
import { buildHotkeys, hotkeysBinary } from "@mouthpiece/hotkeys";
import type { CommandFn } from "../types.ts";

export const buildHotkeysCommand: CommandFn = async (_args, io, deps) => {
  const out = hotkeysBinary(mouthpieceHome(deps.env));
  try {
    await buildHotkeys({ out, exec: deps.exec });
  } catch (error) {
    io.err(`mouthpiece: ${(error as Error).message}\n`);
    return 1;
  }
  io.out(`Built ${out}. Restart the daemon to enable hotkeys.\n`);
  return 0;
};
