import {
  defaultExec,
  type Exec,
  isRecord,
  type ReplyCheck,
  type ReplyDriver,
  type ReplyRoute,
} from "@mouthpiece/core";
import { promptVerdict, screenState } from "./screens.ts";

/** Where Orca installs its CLI; it runs without Orca's environment, so the daemon can call it. */
export const ORCA_BIN = "/Applications/Orca.app/Contents/Resources/bin/orca";

const QUERY_TIMEOUT_MS = 3_000;
const SEND_TIMEOUT_MS = 8_000;
/** The whole visible screen, so a spinner above a long todo list is still seen. */
const SCREEN_LINES = "60";

export interface OrcaReplyDriverOptions {
  exec?: Exec;
  orca?: string;
}

/** Types replies into an Orca terminal (PRD §13), through Orca's CLI. */
export class OrcaReplyDriver implements ReplyDriver {
  readonly via = "orca";
  readonly #exec: Exec;
  readonly #orca: string;

  constructor(opts: OrcaReplyDriverOptions = {}) {
    this.#exec = opts.exec ?? defaultExec;
    this.#orca = opts.orca ?? ORCA_BIN;
  }

  async check(route: ReplyRoute, typed?: string): Promise<ReplyCheck> {
    const shown = await this.#run(["show", "--terminal", route.target, "--json"], QUERY_TIMEOUT_MS);
    if (shown === undefined) return { ok: false, reason: "unverified" };
    const terminal = terminalOf(shown);
    if (!terminal || terminal.connected !== true || terminal.writable !== true) {
      return { ok: false, reason: "gone" };
    }
    if (terminal.agentIdentity !== route.agent) return { ok: false, reason: "not-agent" };
    const read = await this.#run(
      ["read", "--terminal", route.target, "--screen", "--limit", SCREEN_LINES, "--json"],
      QUERY_TIMEOUT_MS,
    );
    const screen = read === undefined ? undefined : terminalOf(read);
    if (!screen || screen.source !== "screen" || !Array.isArray(screen.tail)) {
      return { ok: false, reason: "unverified" };
    }
    if (typeof screen.draft === "string" && screen.draft.trim() !== "") {
      return { ok: false, reason: "draft" };
    }
    const tail = screen.tail.filter((l): l is string => typeof l === "string");
    return promptVerdict(screenState(route.agent, tail), typed);
  }

  async send(route: ReplyRoute, text: string): Promise<{ submitted: boolean }> {
    // `--text=` is Orca's form for a value that starts with `--`. Orca accepts --wait-submit only
    // with text, so Enter alone (submitting a typed reply) goes without it.
    const args = ["send", "--terminal", route.target];
    if (text !== "") args.push(`--text=${text}`, "--enter", "--wait-submit", "5");
    else args.push("--enter");
    args.push("--json");
    const { code, json } = await this.#call(args, SEND_TIMEOUT_MS);
    if (!isRecord(json) || json.ok !== true || !isRecord(json.result)) {
      const error = isRecord(json) && isRecord(json.error) ? json.error.code : "no result";
      throw new Error(`orca terminal send failed: ${String(error)}`);
    }
    const send = json.result.send;
    if (!isRecord(send) || send.accepted !== true) {
      throw new Error("orca terminal send failed: input not accepted");
    }
    if (code !== 0) throw new Error(`orca terminal send failed: exit ${code}`);
    return { submitted: turnStarted(send.prompt) };
  }

  /** Runs `orca terminal <args>`: its JSON, or undefined when it printed none. */
  async #run(args: string[], timeoutMs: number): Promise<unknown> {
    return (await this.#call(args, timeoutMs)).json;
  }

  async #call(args: string[], timeoutMs: number): Promise<{ code: number; json: unknown }> {
    const r = await this.#exec([this.#orca, "terminal", ...args], { timeoutMs });
    try {
      return { code: r.code, json: JSON.parse(r.stdout) };
    } catch {
      return { code: r.code, json: undefined };
    }
  }
}

/** Orca's prompt receipt: submitted only once it saw the agent start a turn in the same process. */
function turnStarted(prompt: unknown): boolean {
  if (!isRecord(prompt) || prompt.observation === "incarnation_replaced") return false;
  return Array.isArray(prompt.stages) && prompt.stages.includes("turn_started");
}

function terminalOf(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result) || result.ok !== true || !isRecord(result.result)) return undefined;
  const terminal = result.result.terminal;
  return isRecord(terminal) ? terminal : undefined;
}
