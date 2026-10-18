import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interrupt, speak } from "@mouthpiece/client";
import {
  type ReplyCheck,
  type ReplyDriver,
  type ReplyRoute,
  resolveConfig,
} from "@mouthpiece/core";
import { FakeProvider } from "@mouthpiece/providers";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { FakePlayer } from "./fake-player.ts";

let home: string;
let daemon: RunningDaemon;
const route: ReplyRoute = { via: "orca", target: "term_abc", agent: "claude" };

class FakeDriver implements ReplyDriver {
  readonly via = "orca";
  sent: string[] = [];
  onSend?: () => Promise<void>;
  async check(): Promise<ReplyCheck> {
    return { ok: true };
  }
  async send(_r: ReplyRoute, text: string) {
    this.sent.push(text);
    await this.onSend?.();
    return { submitted: false };
  }
}

async function boot(driver: FakeDriver, reply: Record<string, unknown> = { enabled: true }) {
  home = await mkdtemp(join(tmpdir(), "mp-e2e-reply-"));
  daemon = await startDaemon({
    env: { MOUTHPIECE_HOME: home, MOUTHPIECE_CONFIG: join(home, "config.toml") },
    port: 0,
    provider: new FakeProvider(),
    player: new FakePlayer({ durationMs: 1 }),
    log: () => {},
    summarizer: null,
    hotkeys: false,
    watch: false,
    config: resolveConfig({ reply }),
    replyDrivers: () => [driver],
  });
}
afterEach(async () => {
  await daemon.stop();
  await rm(home, { recursive: true, force: true });
});
const o = () => ({ url: daemon.url, env: { MOUTHPIECE_HOME: home } });
const call = async (method: string, path: string, body?: unknown) => {
  const token = (await Bun.file(join(home, "token")).text()).trim();
  return fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};
const entries = async () => (await (await call("GET", "/v1/inbox")).json()).entries;

test("a response with a route is in the inbox, and a reply confirmed by the hook is submitted", async () => {
  const driver = new FakeDriver();
  driver.onSend = async () => {
    await interrupt({ source: "agent", conversationId: "c1" }, o());
  };
  await boot(driver);
  await speak(
    {
      text: "Shall I run the migration now?",
      source: "agent",
      conversationId: "c1",
      label: "db",
      reply: route,
    },
    o(),
  );
  const inbox = await (await call("GET", "/v1/inbox")).json();
  expect(inbox.enabled).toBe(true);
  expect(inbox.entries).toHaveLength(1);
  expect(inbox.entries[0]).toMatchObject({ label: "db", state: "waiting", route });
  const res = await call("POST", "/v1/reply", { id: inbox.entries[0].id, text: "yes,\nrun it" });
  expect([res.status, await res.json()]).toEqual([202, { status: "submitted" }]);
  expect(driver.sent).toEqual(["yes, run it"]);
  expect((await entries())[0].state).toBe("busy");
});

test("with no confirmation the reply is typed", async () => {
  await boot(new FakeDriver(), { enabled: true, confirmMs: 1 });
  await speak(
    { text: "Shall I continue?", source: "agent", conversationId: "c1", reply: route },
    o(),
  );
  const [entry] = await entries();
  const res = await call("POST", "/v1/reply", { id: entry.id, text: "go" });
  expect(await res.json()).toEqual({ status: "typed" });
});

test("replies are off by default", async () => {
  await boot(new FakeDriver(), {});
  await speak(
    { text: "Shall I continue?", source: "agent", conversationId: "c1", reply: route },
    o(),
  );
  const [entry] = await entries();
  expect((await call("POST", "/v1/reply", { id: entry.id, text: "go" })).status).toBe(403);
});

test("a muted response is still in the inbox", async () => {
  await boot(new FakeDriver());
  await call("POST", "/v1/mode", { mode: "off" });
  expect(await speak({ text: "Shall I continue?", source: "agent", reply: route }, o())).toEqual({
    id: null,
    skipped: "muted",
  });
  expect(await entries()).toHaveLength(1);
});
