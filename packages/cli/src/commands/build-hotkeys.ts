import { mouthpieceHome } from "@mouthpiece/core";
import { buildHelper } from "@mouthpiece/hotkeys";
import type { CommandFn } from "../types.ts";

/** `build-hotkeys` / `build-helper`: builds MouthpieceHelper.app (hotkeys, menubar, mic pause). */
export const buildHotkeysCommand: CommandFn = async (_args, io, deps) => {
  let app: string;
  try {
    app = await buildHelper({ home: mouthpieceHome(deps.env), exec: deps.exec });
  } catch (error) {
    io.err(`mouthpiece: ${(error as Error).message}\n`);
    return 1;
  }
  io.out(`Built ${app}. Restart the daemon to enable hotkeys, the menubar and mic pause.\n`);
  return 0;
};
