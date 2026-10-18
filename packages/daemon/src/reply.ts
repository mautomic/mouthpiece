import type {
  Config,
  Logger,
  ReplyCheck,
  ReplyDriver,
  ReplyRefusal,
  ReplyRequest,
  ReplySubmitRequest,
} from "@mouthpiece/core";
import type { Inbox, StoredEntry } from "./inbox.ts";

export const MAX_REPLY_CHARS = 4000;

/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Delivery control 2 (PRD §13): one line of plain text, exactly as it will be typed. Control
 * characters become spaces, so a pasted ESC or Ctrl-C never reaches the agent as a keystroke.
 */
export function oneLine(text: string): string {
  return text.replace(CONTROLS, " ").replace(/ {2,}/g, " ").trim();
}

type RefusalStatus = 400 | 403 | 409 | 410 | 413 | 422 | 502;

export type ReplyResult =
  | { ok: true; status: "submitted" | "typed" }
  | { ok: false; http: RefusalStatus; reason: ReplyRefusal; error: string };

export interface ReplyControllerOptions {
  inbox: Inbox;
  drivers: ReplyDriver[];
  /** Read per request, so a config reload applies to the next reply (FR-11). */
  config: () => Config["reply"];
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const REFUSALS: Record<ReplyRefusal, { http: RefusalStatus; error: string }> = {
  invalid: { http: 400, error: "the reply is empty" },
  disabled: { http: 403, error: "replies are disabled; set [reply] enabled = true" },
  busy: { http: 409, error: "the session is busy" },
  newer: { http: 409, error: "a newer response arrived; read it first" },
  "in-flight": { http: 409, error: "a reply to this session is already in flight" },
  "not-typed": { http: 409, error: "there is no typed reply to submit" },
  draft: { http: 409, error: "the prompt is not empty" },
  "not-idle": { http: 409, error: "the agent is working" },
  "not-agent": { http: 409, error: "the terminal no longer runs that agent" },
  unverified: { http: 409, error: "could not check the terminal" },
  gone: { http: 410, error: "that response or terminal is gone" },
  "too-long": { http: 413, error: `the reply is over ${MAX_REPLY_CHARS} characters` },
  "no-route": { http: 422, error: "no way to reply to this session" },
  "send-failed": { http: 502, error: "typing into the terminal failed" },
};

function refuse(reason: ReplyRefusal): ReplyResult {
  return { ok: false, reason, ...REFUSALS[reason] };
}

/** Delivers replies under the PRD §13 delivery controls (US-025). */
export class ReplyController {
  readonly #opts: ReplyControllerOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Replies waiting for a prompt-submit interrupt, by source + conversation. */
  readonly #pending = new Map<string, () => void>();

  constructor(opts: ReplyControllerOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /** A prompt-submit interrupt: confirms a reply waiting for one (control 1). */
  interrupted(source: string, conversationId?: string): void {
    for (const [key, confirm] of this.#pending) {
      const [s, c] = key.split("\u0000");
      if (s === source && (conversationId === undefined || c === conversationId)) confirm();
    }
  }

  async reply(req: ReplyRequest): Promise<ReplyResult> {
    if (!this.#opts.config().enabled) return refuse("disabled");
    const text = oneLine(req.text);
    if (text === "") return refuse("invalid");
    if (text.length > MAX_REPLY_CHARS) return refuse("too-long");
    const entry = this.#opts.inbox.get(req.id);
    if (!entry) return refuse(this.#opts.inbox.replaced(req.id) ? "newer" : "gone");
    if (entry.state === "busy") return this.#refused(entry, "busy");
    if (entry.state !== "waiting") return this.#refused(entry, "in-flight");
    return this.#deliver(entry, text, undefined);
  }

  async submit(req: ReplySubmitRequest): Promise<ReplyResult> {
    if (!this.#opts.config().enabled) return refuse("disabled");
    const entry = this.#opts.inbox.get(req.id);
    if (!entry) return refuse(this.#opts.inbox.replaced(req.id) ? "newer" : "gone");
    if (entry.state !== "typed" || entry.replyText === undefined) {
      return this.#refused(entry, "not-typed");
    }
    return this.#deliver(entry, "", entry.replyText);
  }

  /** Types `text`; with `typed` (and `text` ""), presses Enter for that typed reply. */
  async #deliver(
    entry: StoredEntry,
    text: string,
    typed: string | undefined,
  ): Promise<ReplyResult> {
    const route = entry.route;
    const driver = this.#opts.drivers.find((d) => d.via === route?.via);
    if (!route || !driver) return this.#refused(entry, "no-route");
    const { inbox } = this.#opts;
    const restore = typed === undefined ? "waiting" : "typed";
    inbox.setState(entry.id, "sending"); // synchronous: a second reply now sees in-flight
    let check: ReplyCheck;
    try {
      check = await driver.check(route, typed);
    } catch {
      check = { ok: false, reason: "unverified" };
    }
    if (!check.ok) {
      this.#restore(entry.id, restore);
      const reason = typed !== undefined && check.reason === "draft" ? "not-typed" : check.reason;
      return this.#refused(entry, reason);
    }
    // Control 3: an interrupt during the check means someone typed at that prompt. Don't add to it.
    if (inbox.get(entry.id)?.state !== "sending") return this.#refused(entry, "busy");
    const key = `${entry.source}\u0000${entry.conversationId}`;
    let confirmed = false;
    const confirmation = new Promise<void>((resolve) => {
      this.#pending.set(key, () => {
        confirmed = true;
        resolve();
      });
    });
    try {
      let submitted: boolean;
      try {
        ({ submitted } = await driver.send(route, text));
      } catch (error) {
        // The prompt-submit hook already confirmed: the text went in, whatever the CLI reports.
        if (confirmed) return this.#finish(entry, true, typed ?? text);
        this.#restore(entry.id, restore);
        this.#opts.log({ level: "warn", msg: "reply_send_failed", error: String(error) });
        return this.#refused(entry, "send-failed");
      }
      if (!submitted && !confirmed) {
        await Promise.race([confirmation, this.#sleep(this.#opts.config().confirmMs)]);
      }
      return this.#finish(entry, submitted || confirmed, typed ?? text);
    } finally {
      this.#pending.delete(key);
    }
  }

  #finish(entry: StoredEntry, done: boolean, text: string): ReplyResult {
    this.#opts.inbox.setState(entry.id, done ? "busy" : "typed", { text, at: this.#now() });
    const status = done ? "submitted" : "typed";
    this.#log(entry, { result: status });
    return { ok: true, status };
  }

  #restore(id: string, state: "waiting" | "typed"): void {
    if (this.#opts.inbox.get(id)?.state === "sending") this.#opts.inbox.setState(id, state);
  }

  #refused(entry: StoredEntry, reason: ReplyRefusal): ReplyResult {
    this.#log(entry, { result: "refused", reason });
    return refuse(reason);
  }

  #log(entry: StoredEntry, fields: { result: string; reason?: string }): void {
    this.#opts.log({
      msg: "reply",
      source: entry.source,
      ...(entry.label !== undefined && { label: entry.label }),
      ...(entry.route && { via: entry.route.via }),
      ...fields,
    });
  }
}
