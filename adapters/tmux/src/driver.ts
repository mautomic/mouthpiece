import { type ConversationDriver, defaultExec, type Exec } from "@mouthpiece/core";

/** A tmux target: a session, window or pane (`cc`, `cc:1.0`, `%3`, `$1`). No spaces or shell syntax. */
export const TMUX_TARGET = /^[\w.:%$-]+$/;

export interface TmuxDriverOptions {
  /** Which source's conversations this driver answers (PRD §12). Default `claude-code`. */
  source?: string;
  exec?: Exec;
  /** The tmux binary. Default `tmux` from PATH. */
  tmux?: string;
}

/**
 * Conversation driver (a) from PRD §12: types a prompt into the tmux pane that runs an
 * interactive agent, then presses Enter. The conversation id is the tmux target.
 */
export class TmuxDriver implements ConversationDriver {
  readonly source: string;
  private readonly exec: Exec;
  private readonly tmux: string;

  constructor(opts: TmuxDriverOptions = {}) {
    this.source = opts.source ?? "claude-code";
    this.exec = opts.exec ?? defaultExec;
    this.tmux = opts.tmux ?? "tmux";
  }

  async send(target: string, text: string): Promise<void> {
    if (!TMUX_TARGET.test(target)) {
      throw new Error(`invalid tmux target: ${JSON.stringify(target)}`);
    }
    const line = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!line) throw new Error("refusing to send empty text");
    // `--` keeps text like "-n" from being read as a flag. tmux splits commands on an argument
    // that ends in ";" unless it is escaped as "\;".
    await this.run(["send-keys", "-t", target, "-l", "--", escapeTrailingSemicolon(line)]);
    await this.run(["send-keys", "-t", target, "Enter"]);
  }

  private async run(args: string[]): Promise<void> {
    const r = await this.exec([this.tmux, ...args]);
    if (r.code !== 0) {
      throw new Error(`tmux ${args[0]} failed (${r.code}): ${r.stderr.trim() || "no output"}`);
    }
  }
}

function escapeTrailingSemicolon(text: string): string {
  return text.endsWith(";") ? `${text.slice(0, -1)}\\;` : text;
}

/** True when `tmux -V` runs. */
export async function isTmuxAvailable(exec: Exec = defaultExec, tmux = "tmux"): Promise<boolean> {
  try {
    return (await exec([tmux, "-V"])).code === 0;
  } catch {
    return false;
  }
}
