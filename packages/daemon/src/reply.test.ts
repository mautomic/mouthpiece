import { expect, test } from "bun:test";
import {
  parseSpeakEvent,
  type ReplyCheck,
  type ReplyDriver,
  type ReplyRoute,
} from "@mouthpiece/core";
import { Inbox } from "./inbox.ts";
import { MAX_REPLY_CHARS, oneLine, ReplyController } from "./reply.ts";

const route: ReplyRoute = { via: "orca", target: "term_abc", agent: "claude" };

class FakeDriver implements ReplyDriver {
  readonly via = "orca";
  checks: ReplyCheck[] = [];
  sent: string[] = [];
  submitted = false;
  failSend = false;
  onCheck?: () => void;
  onSend?: () => void;
  async check(): Promise<ReplyCheck> {
    this.onCheck?.();
    return this.checks.shift() ?? { ok: true };
  }
  async send(_route: ReplyRoute, text: string) {
    this.sent.push(text);
    this.onSend?.();
    if (this.failSend) throw new Error("orca terminal send failed: boom");
    return { submitted: this.submitted };
  }
}

function setup(opts: { enabled?: boolean; withRoute?: boolean } = {}) {
  const inbox = new Inbox({ history: { maxItems: 100, maxAgeMs: 3_600_000 }, now: () => 1_000 });
  const driver = new FakeDriver();
  const logs: Record<string, unknown>[] = [];
  let release: () => void = () => {};
  const sleeps: number[] = [];
  const controller = new ReplyController({
    inbox,
    drivers: [driver],
    config: () => ({ enabled: opts.enabled ?? true, confirmMs: 5000, popup: "away" }),
    log: (r) => logs.push(r),
    now: () => 2_000,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise((r) => {
        release = r;
      });
    },
  });
  const speak = (fields: Record<string, unknown> = {}) => {
    const r = parseSpeakEvent({
      source: "agent",
      conversationId: "c1",
      label: "web",
      text: "Shall I continue?",
      ...(opts.withRoute !== false && { reply: route }),
      ...fields,
    });
    if (!r.ok) throw new Error(r.error);
    return inbox.record(r.value) as string;
  };
  return { inbox, driver, controller, logs, speak, sleeps, timeout: () => release() };
}

test("oneLine joins lines and trims", () => {
  expect(oneLine("  fix the tests\n\n  but not fixtures \r\n")).toBe(
    "fix the tests but not fixtures",
  );
});

test("a confirmed send is submitted and the entry is busy", async () => {
  const { controller, driver, inbox, speak } = setup();
  driver.submitted = true;
  const id = speak();
  expect(await controller.reply({ id, text: "yes\ncontinue" })).toEqual({
    ok: true,
    status: "submitted",
  });
  expect(driver.sent).toEqual(["yes continue"]);
  expect(inbox.get(id)?.state).toBe("busy");
});

test("an interrupt during the confirm wait means submitted", async () => {
  const { controller, driver, inbox, speak } = setup();
  driver.onSend = () => controller.interrupted("agent", "c1");
  const id = speak();
  expect(await controller.reply({ id, text: "go" })).toEqual({ ok: true, status: "submitted" });
  expect(inbox.get(id)?.state).toBe("busy");
});

test("no confirmation within confirmMs means typed, never resent", async () => {
  const { controller, driver, inbox, speak, sleeps, timeout } = setup();
  const id = speak();
  const pending = controller.reply({ id, text: "go" });
  await Bun.sleep(0);
  expect(sleeps).toEqual([5000]);
  timeout();
  expect(await pending).toEqual({ ok: true, status: "typed" });
  expect(driver.sent).toEqual(["go"]);
  expect(inbox.get(id)).toMatchObject({ state: "typed", replyText: "go" });
});

test("refusals before any check: disabled, empty, too long, gone, newer, busy, no route", async () => {
  const off = setup({ enabled: false });
  expect(await off.controller.reply({ id: off.speak(), text: "go" })).toMatchObject({
    ok: false,
    http: 403,
    reason: "disabled",
  });

  const s = setup();
  s.driver.submitted = true;
  const id = s.speak();
  expect(await s.controller.reply({ id, text: " \n " })).toMatchObject({
    http: 400,
    reason: "invalid",
  });
  expect(await s.controller.reply({ id, text: "x".repeat(MAX_REPLY_CHARS) })).toMatchObject({
    ok: true,
  });
  const id2 = s.speak({ conversationId: "c2" });
  expect(
    await s.controller.reply({ id: id2, text: "x".repeat(MAX_REPLY_CHARS + 1) }),
  ).toMatchObject({ http: 413, reason: "too-long" });
  expect(await s.controller.reply({ id: "nope", text: "go" })).toMatchObject({
    http: 410,
    reason: "gone",
  });

  const n = setup();
  const old = n.speak();
  n.speak({ text: "Newer question?" });
  expect(await n.controller.reply({ id: old, text: "go" })).toMatchObject({
    http: 409,
    reason: "newer",
  });

  const b = setup();
  const busy = b.speak();
  b.inbox.interrupted("agent", "c1");
  expect(await b.controller.reply({ id: busy, text: "go" })).toMatchObject({
    http: 409,
    reason: "busy",
  });

  const r = setup({ withRoute: false });
  expect(await r.controller.reply({ id: r.speak(), text: "go" })).toMatchObject({
    http: 422,
    reason: "no-route",
  });
  expect([s.driver.sent.length, b.driver.sent.length, r.driver.sent.length]).toEqual([1, 0, 0]);
});

test("a second reply while one is in flight is refused", async () => {
  const { controller, driver, speak } = setup();
  driver.submitted = true;
  const id = speak();
  const first = controller.reply({ id, text: "go" });
  expect(await controller.reply({ id, text: "again" })).toMatchObject({
    http: 409,
    reason: "in-flight",
  });
  expect(await first).toEqual({ ok: true, status: "submitted" });
  expect(driver.sent).toEqual(["go"]);
});

test("each failed check refuses and returns the entry to waiting", async () => {
  for (const reason of ["not-agent", "not-idle", "draft", "unverified"] as const) {
    const { controller, driver, inbox, speak } = setup();
    driver.checks = [{ ok: false, reason }];
    const id = speak();
    expect(await controller.reply({ id, text: "go" })).toMatchObject({
      ok: false,
      http: 409,
      reason,
    });
    expect(inbox.get(id)?.state).toBe("waiting");
    expect(driver.sent).toEqual([]);
  }
  const g = setup();
  g.driver.checks = [{ ok: false, reason: "gone" }];
  expect(await g.controller.reply({ id: g.speak(), text: "go" })).toMatchObject({
    http: 410,
    reason: "gone",
  });
});

test("you typing in the terminal during the check stops the send", async () => {
  const { controller, driver, inbox, speak } = setup();
  const id = speak();
  driver.onCheck = () => inbox.interrupted("agent", "c1");
  expect(await controller.reply({ id, text: "go" })).toMatchObject({ http: 409, reason: "busy" });
  expect(driver.sent).toEqual([]);
});

test("a new response during the send keeps the new entry waiting", async () => {
  const { controller, driver, inbox, speak } = setup();
  driver.submitted = true;
  const id = speak();
  let newer = "";
  driver.onSend = () => {
    newer = speak({ text: "Another question?" });
  };
  expect(await controller.reply({ id, text: "go" })).toEqual({ ok: true, status: "submitted" });
  expect(inbox.get(newer)?.state).toBe("waiting");
});

test("a failed send is a 502 and the entry is waiting again", async () => {
  const { controller, driver, inbox, speak } = setup();
  driver.failSend = true;
  const id = speak();
  expect(await controller.reply({ id, text: "go" })).toMatchObject({
    http: 502,
    reason: "send-failed",
  });
  expect(inbox.get(id)?.state).toBe("waiting");
});

test("submit presses Enter alone, only for a typed reply", async () => {
  const { controller, driver, inbox, speak, timeout } = setup();
  const id = speak();
  expect(await controller.submit({ id })).toMatchObject({ http: 409, reason: "not-typed" });
  const pending = controller.reply({ id, text: "go" });
  await Bun.sleep(0);
  timeout();
  await pending;
  driver.submitted = true;
  expect(await controller.submit({ id })).toEqual({ ok: true, status: "submitted" });
  expect(driver.sent).toEqual(["go", ""]);
  expect(inbox.get(id)?.state).toBe("busy");
});

test("submit refuses when the typed text is no longer at the prompt", async () => {
  const { controller, driver, speak, timeout } = setup();
  const id = speak();
  const pending = controller.reply({ id, text: "go" });
  await Bun.sleep(0);
  timeout();
  await pending;
  driver.checks = [{ ok: false, reason: "draft" }];
  expect(await controller.submit({ id })).toMatchObject({ http: 409, reason: "not-typed" });
});

test("logs say what happened, never the reply text", async () => {
  const { controller, driver, logs, speak } = setup();
  driver.submitted = true;
  await controller.reply({ id: speak(), text: "the secret plan" });
  driver.checks = [{ ok: false, reason: "draft" }];
  await controller.reply({ id: speak({ conversationId: "c2" }), text: "the secret plan" });
  expect(logs).toEqual([
    { msg: "reply", source: "agent", label: "web", via: "orca", result: "submitted" },
    {
      msg: "reply",
      source: "agent",
      label: "web",
      via: "orca",
      result: "refused",
      reason: "draft",
    },
  ]);
  expect(JSON.stringify(logs)).not.toContain("secret");
});

test("oneLine folds control characters, so nothing but text is typed", () => {
  expect(oneLine("go\u001b[31m now\u0003\tthen\u007f\u0085 done\u2028ok")).toBe(
    "go [31m now then done ok",
  );
});

test("a send that times out after the turn was confirmed is still submitted", async () => {
  const { controller, driver, inbox, speak } = setup();
  driver.failSend = true;
  driver.onSend = () => controller.interrupted("agent", "c1");
  const id = speak();
  expect(await controller.reply({ id, text: "go" })).toEqual({ ok: true, status: "submitted" });
  expect(inbox.get(id)?.state).toBe("busy");
});
