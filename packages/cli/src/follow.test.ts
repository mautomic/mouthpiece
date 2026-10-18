import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeakEvent } from "@mouthpiece/core";
import { createFollower } from "./follow.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-follow-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(env: Record<string, string> = {}) {
  const spoken: SpeakEvent[] = [];
  const warnings: string[] = [];
  return {
    spoken,
    warnings,
    deps: {
      speak: async (e: SpeakEvent) => {
        spoken.push(e);
        return { id: "1" };
      },
      env: { HOME: dir, ...env },
      warn: (s: string) => warnings.push(s),
    },
  };
}

test("an unknown format or a lines follower without a path is an error, not a follower", () => {
  expect(createFollower({ format: "nope" }, deps().deps)).toEqual({
    error: "unknown format nope (codex, gemini, lines, margin)",
  });
  expect(createFollower({ format: "lines" }, deps().deps)).toEqual({
    error: "--format lines needs a path",
  });
});

test("margin speaks agent replies with the doc's name, always announced", async () => {
  const state = join(dir, "state");
  const docs = join(dir, "docs");
  await mkdir(state);
  await mkdir(join(docs, ".margin"), { recursive: true });
  const doc = join(docs, "PRD.md");
  const log = join(docs, ".margin", "PRD.md.jsonl");
  await writeFile(log, "");
  await writeFile(join(state, "recent-docs.json"), JSON.stringify([doc]));
  const h = deps({ MARGIN_STATE_DIR: state });
  const f = createFollower({ format: "margin" }, h.deps);
  if ("error" in f) throw new Error(f.error);
  await f.poll();
  await appendFile(
    log,
    `${JSON.stringify({ seq: 1, type: "reply", by: "agent", id: "c4", text: "Done: see **US-014**." })}\n`,
  );
  await f.poll();
  await f.stop();
  expect(h.spoken).toEqual([
    {
      text: "Done: see **US-014**.",
      source: "margin",
      conversationId: `${doc}#c4`,
      label: "PRD",
      kind: "response",
      format: "markdown",
      announce: "always",
    },
  ]);
});

test("a margin path is the one doc to follow", async () => {
  const docs = join(dir, "docs");
  await mkdir(join(docs, ".margin"), { recursive: true });
  const doc = join(docs, "notes.md");
  const h = deps({ MARGIN_STATE_DIR: join(dir, "no-state") });
  const f = createFollower({ format: "margin", path: doc, label: "notes doc" }, h.deps);
  if ("error" in f) throw new Error(f.error);
  await f.poll();
  await writeFile(
    join(docs, ".margin", "notes.md.jsonl"),
    `${JSON.stringify({ seq: 1, type: "reply", by: "agent", id: "c1", text: "Hi." })}\n`,
  );
  await f.poll();
  await f.stop();
  expect(h.spoken.map((e) => [e.text, e.label])).toEqual([["Hi.", "notes doc"]]);
});
