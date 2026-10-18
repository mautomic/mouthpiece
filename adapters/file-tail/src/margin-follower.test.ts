import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarginFollower, marginStateDir } from "./margin-follower.ts";
import type { TailMessage } from "./tailer.ts";

let dir: string;
let state: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-margin-"));
  state = join(dir, "state");
  await mkdir(state);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const reply = (seq: number, text: string, by = "agent", id = "c1") =>
  `${JSON.stringify({ seq, at: "2026-10-18T12:00:00.000Z", type: "reply", by, id, text })}\n`;

/** A doc with a log holding `lines`, and its paths. */
async function doc(name: string, lines = "") {
  const folder = join(dir, "docs");
  await mkdir(join(folder, ".margin"), { recursive: true });
  const path = join(folder, name);
  await writeFile(path, "# doc\n");
  const log = join(folder, ".margin", `${name}.jsonl`);
  if (lines) await writeFile(log, lines);
  return { path, log };
}

/**
 * A fake Margin server: `docs` is what `GET /api/status` reports (path and open tabs), `down`
 * refuses connections, `broken` answers 500. `running` writes or removes its daemon.json.
 */
function margin() {
  const server = {
    docs: [] as { path: string; clients: number }[],
    down: false,
    broken: false,
    requests: [] as { url: string; auth: string | null }[],
  };
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    server.requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (server.down)
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    if (server.broken) return new Response("oops", { status: 500 });
    return Response.json({
      pid: 1,
      port: 4417,
      protocol: 2,
      startedAt: "2026-10-18T12:00:00.000Z",
      docs: server.docs.map((d, i) => ({ docId: `d${i}`, missing: false, ...d })),
    });
  };
  const running = (on: boolean) =>
    on
      ? writeFile(
          join(state, "daemon.json"),
          JSON.stringify({ pid: 1, port: 4417, token: "tok-1", protocol: 2, startedAt: "x" }),
        )
      : rm(join(state, "daemon.json"), { force: true });
  return { server, fetch, running };
}

function follower(m: ReturnType<typeof margin>, opts: { doc?: string; rescanMs?: number } = {}) {
  const spoken: TailMessage[] = [];
  const followed: string[] = [];
  const dropped: string[] = [];
  const errors: unknown[] = [];
  const t = { now: 0 };
  const f = new MarginFollower({
    ...opts,
    env: { MARGIN_STATE_DIR: state },
    onMessage: (msg) => spoken.push(msg),
    onFollow: (log) => followed.push(log),
    onUnfollow: (log) => dropped.push(log),
    onError: (e) => errors.push(e),
    rescanMs: opts.rescanMs ?? 0,
    now: () => t.now,
    fetch: m.fetch,
  });
  return { f, spoken, followed, dropped, errors, t };
}

test("asks Margin's server for its docs with the server's own token", async () => {
  const m = margin();
  await m.running(true);
  await follower(m).f.poll();
  expect(m.server.requests).toEqual([
    { url: "http://127.0.0.1:4417/api/status", auth: "Bearer tok-1" },
  ]);
});

test("follows a doc with a tab open from its end, then speaks new agent replies", async () => {
  const prd = await doc("PRD.md", reply(1, "history is not spoken"));
  const m = margin();
  await m.running(true);
  m.server.docs = [{ path: prd.path, clients: 1 }];
  const h = follower(m);
  await h.f.poll();
  expect(h.followed).toEqual([prd.log]);
  await appendFile(prd.log, reply(2, "please fix", "user") + reply(3, "Fixed in the summary."));
  await h.f.poll();
  expect(h.spoken).toEqual([
    { text: "Fixed in the summary.", conversationId: `${prd.path}#c1`, label: "PRD" },
  ]);
});

test("a doc is followed only while a tab shows it", async () => {
  const prd = await doc("PRD.md", reply(1, "old"));
  const m = margin();
  await m.running(true);
  m.server.docs = [{ path: prd.path, clients: 0 }]; // open on the server, no tab
  const h = follower(m);
  await h.f.poll();
  expect(h.followed).toEqual([]);

  m.server.docs = [{ path: prd.path, clients: 2 }];
  await h.f.poll();
  await appendFile(prd.log, reply(2, "While open."));
  await h.f.poll();

  m.server.docs = [{ path: prd.path, clients: 0 }]; // the tab closes
  await h.f.poll();
  await appendFile(prd.log, reply(3, "After it closed."));
  await h.f.poll();

  m.server.docs = [{ path: prd.path, clients: 1 }]; // opened again: from its end
  await h.f.poll();
  await appendFile(prd.log, reply(4, "Opened again."));
  await h.f.poll();

  expect(h.spoken.map((s) => s.text)).toEqual(["While open.", "Opened again."]);
  expect(h.followed).toEqual([prd.log, prd.log]);
  expect(h.dropped).toEqual([prd.log]);
});

test("with Margin not running (no daemon.json, or nothing listening), nothing is followed", async () => {
  const prd = await doc("PRD.md", reply(1, "old"));
  const m = margin();
  m.server.docs = [{ path: prd.path, clients: 1 }];
  const h = follower(m);
  await h.f.poll();
  expect(h.followed).toEqual([]);
  expect(m.server.requests).toEqual([]);

  await m.running(true);
  await h.f.poll();
  expect(h.followed).toEqual([prd.log]);

  m.server.down = true; // Margin exited and left a stale daemon.json
  await h.f.poll();
  expect(h.dropped).toEqual([prd.log]);
});

test("an answer Margin can't give (an error, garbage) keeps what is followed", async () => {
  const prd = await doc("PRD.md", reply(1, "old"));
  const m = margin();
  await m.running(true);
  m.server.docs = [{ path: prd.path, clients: 1 }];
  const h = follower(m);
  await h.f.poll();
  m.server.broken = true;
  await h.f.poll();
  await appendFile(prd.log, reply(2, "Still heard."));
  await h.f.poll();
  expect(h.dropped).toEqual([]);
  expect(h.spoken.map((s) => s.text)).toEqual(["Still heard."]);
});

test("odd entries in the server's list are ignored", async () => {
  const prd = await doc("PRD.md", reply(1, "old"));
  const m = margin();
  await m.running(true);
  m.server.docs = [
    { path: prd.path, clients: 1 },
    { path: "relative/doc.md", clients: 1 },
    { path: 7 as unknown as string, clients: 1 },
  ];
  const h = follower(m);
  await h.f.poll();
  expect(h.followed).toEqual([prd.log]);
});

test("the server is asked only every rescanMs", async () => {
  const m = margin();
  await m.running(true);
  const h = follower(m, { rescanMs: 2000 });
  await h.f.poll();
  h.t.now = 1999;
  await h.f.poll();
  expect(m.server.requests).toHaveLength(1);
  h.t.now = 2000;
  await h.f.poll();
  expect(m.server.requests).toHaveLength(2);
});

test("with a doc, follows just that doc and never asks Margin", async () => {
  const prd = await doc("PRD.md", reply(1, "old"));
  const m = margin();
  await m.running(true);
  const h = follower(m, { doc: prd.path });
  await h.f.poll();
  await appendFile(prd.log, reply(2, "New."));
  await h.f.poll();
  expect(h.followed).toEqual([prd.log]);
  expect(h.spoken.map((s) => s.text)).toEqual(["New."]);
  expect(m.server.requests).toEqual([]);
});

test("a log created after its doc's tab opened is read from its start", async () => {
  const notes = await doc("notes.md");
  const m = margin();
  await m.running(true);
  m.server.docs = [{ path: notes.path, clients: 1 }];
  const h = follower(m);
  await h.f.poll();
  await writeFile(notes.log, reply(1, "First reply."));
  await h.f.poll();
  expect(h.spoken.map((s) => s.text)).toEqual(["First reply."]);
});

test("a torn line already in the log when following starts never brings back its history", async () => {
  const prd = await doc("PRD.md", reply(1, "H1") + reply(2, "H2"));
  const repaired = (await Bun.file(prd.log).text()).length;
  await appendFile(prd.log, '{"seq":3,"type":"rep'); // an earlier Margin crash
  const m = margin();
  await m.running(true);
  m.server.docs = [{ path: prd.path, clients: 1 }];
  const h = follower(m);
  await h.f.poll();
  await truncate(prd.log, repaired); // Margin's repair at the next reply
  await appendFile(prd.log, reply(3, "New."));
  await h.f.poll();
  expect(h.spoken.map((s) => s.text)).toEqual(["New."]);
});

test("a crash and repair before any new reply never brings back the history", async () => {
  const prd = await doc("PRD.md", reply(1, "H1") + reply(2, "H2"));
  const m = margin();
  await m.running(true);
  m.server.docs = [{ path: prd.path, clients: 1 }];
  const h = follower(m);
  await h.f.poll();
  const before = (await Bun.file(prd.log).text()).length;
  await appendFile(prd.log, '{"seq":3,"type":"rep');
  await h.f.poll();
  await truncate(prd.log, before);
  await appendFile(prd.log, reply(3, "New."));
  await h.f.poll();
  expect(h.spoken.map((s) => s.text)).toEqual(["New."]);
});

test("a pass that stalls never lets polls pile up behind it", async () => {
  let stats = 0;
  const f = new MarginFollower({
    env: { MARGIN_STATE_DIR: state },
    onMessage: () => {},
    pollMs: 1,
    fs: {
      stat: () => {
        stats++;
        return new Promise(() => {}); // an offline volume: never answers
      },
      readRange: async () => new Uint8Array(),
      listDir: async () => [],
    },
    fetch: margin().fetch,
  });
  let polls = 0;
  const poll = f.poll.bind(f);
  f.poll = () => {
    polls++;
    return poll();
  };
  f.start();
  await Bun.sleep(30);
  f.stop();
  expect(stats).toBe(1);
  expect(polls).toBeLessThanOrEqual(1);
});

test("marginStateDir follows Margin's own order", () => {
  expect(marginStateDir({ MARGIN_STATE_DIR: "/s", XDG_RUNTIME_DIR: "/x", HOME: "/h" })).toBe("/s");
  expect(marginStateDir({ XDG_RUNTIME_DIR: "/x", HOME: "/h" })).toBe("/x/margin");
  expect(marginStateDir({ HOME: "/h" })).toBe("/h/.cache/margin");
});
