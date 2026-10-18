import { parseArgs } from "node:util";
import { isTmuxAvailable, TMUX_TARGET, TmuxDriver } from "@mouthpiece/adapter-tmux";
import type { CommandFn } from "../types.ts";

const USAGE = "usage: mouthpiece send --tmux <target> [text…]   (text from stdin when omitted)";

/**
 * `mouthpiece send --tmux <target> <text…>` (PRD §12 conversation spike). Types the text into a
 * tmux pane and presses Enter. Text comes from the arguments, or from piped stdin.
 */
export const sendCommand: CommandFn = async (args, io, deps) => {
  let values: { tmux?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { tmux: { type: "string" } },
    }));
  } catch (error) {
    io.err(`mouthpiece: ${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const target = values.tmux;
  if (target === undefined) {
    io.err(`mouthpiece: send needs a target\n${USAGE}\n`);
    return 2;
  }
  if (!TMUX_TARGET.test(target)) {
    io.err(`mouthpiece: invalid tmux target: ${JSON.stringify(target)}\n`);
    return 2;
  }
  const text = (
    positionals.length > 0 ? positionals.join(" ") : io.stdinIsTTY ? "" : await io.readStdin()
  ).trim();
  if (!text) {
    io.err(`mouthpiece: nothing to send (pass text or pipe it in)\n${USAGE}\n`);
    return 2;
  }
  if (!(await isTmuxAvailable(deps.exec))) {
    io.err("mouthpiece: tmux not found; install tmux: brew install tmux\n");
    return 1;
  }
  try {
    await new TmuxDriver({ exec: deps.exec }).send(target, text);
  } catch (error) {
    io.err(`mouthpiece: ${(error as Error).message}\n`);
    return 1;
  }
  io.err(`sent to ${target}\n`);
  return 0;
};
