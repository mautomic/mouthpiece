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
const SCREEN_LINES = "15";

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
    const args = ["send", "--terminal", route.target];
    if (text !== "") args.push("--text", text);
    args.push("--enter", "--wait-submit", "5", "--json");
    const result = await this.#run(args, SEND_TIMEOUT_MS);
    if (!isRecord(result) || result.ok !== true) {
      const code = isRecord(result) && isRecord(result.error) ? result.error.code : "no result";
      throw new Error(`orca terminal send failed: ${String(code)}`);
    }
    // Per the spec, `submitted` waits on the field names from a real run of this command. Until
    // they are recorded, the session's prompt-submit hook confirms.
    return { submitted: false };
  }

  /** Runs `orca terminal <args>`: its JSON, or undefined when it printed none. */
  async #run(args: string[], timeoutMs: number): Promise<unknown> {
    const r = await this.#exec([this.#orca, "terminal", ...args], { timeoutMs });
    try {
      return JSON.parse(r.stdout);
    } catch {
      return undefined;
    }
  }
}

function terminalOf(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result) || result.ok !== true || !isRecord(result.result)) return undefined;
  const terminal = result.result.terminal;
  return isRecord(terminal) ? terminal : undefined;
}
