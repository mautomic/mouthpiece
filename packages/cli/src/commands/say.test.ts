import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MouthpieceError } from "@mouthpiece/client";
import type { SpeakEvent } from "@mouthpiece/core";
import { run } from "../run.ts";
import type { CliDeps, CliIO } from "../types.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mouthpiece-say-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(opts: { unreachable?: boolean; execCode?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const spoken: SpeakEvent[] = [];
  const execCalls: { cmd: string[]; fileText: string | null }[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => "",
    stdinIsTTY: true,
  };
  const deps: CliDeps = {
    client: {
      speak: async (e) => {
        if (opts.unreachable) {
          throw new MouthpieceError(
            "mouthpiece daemon unreachable at http://127.0.0.1:7317: connection refused",
          );
        }
        spoken.push(e);
        return { id: "abc" };
      },
      stop: async () => ({ stopped: true, dropped: 0 }),
      skip: async () => ({ skipped: true }),
      health: async () => ({ ok: true, version: "0.1.0", provider: "say", queueDepth: 0 }),
      getMode: async () => ({ default: "summary", overrides: [] }),
      setMode: async () => ({ default: "summary", overrides: [] }),
      replay: async () => ({ id: null }),
      usage: async () => ({ from: "a", to: "b", rows: [], quotas: [] }),
      status: async () => ({
        version: "0.1.0",
        speaking: false,
        paused: false,
        pauseReasons: [],
        mode: "summary",
        queueDepth: 0,
        provider: "say",
        current: null,
      }),
      pause: async () => ({ paused: true, pauseReasons: ["user"] }),
      resume: async () => ({ paused: false, pauseReasons: [] }),
      voices: async () => ({ providers: [] }),
    },
    startDaemon: async () => ({ url: "http://127.0.0.1:7317" }),
    env: {},
    exec: async (cmd) => {
      const path = cmd[2];
      execCalls.push({
        cmd,
        fileText: path && existsSync(path) ? readFileSync(path, "utf8") : null,
      });
      return { code: opts.execCode ?? 0, stdout: "", stderr: "" };
    },
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, spoken, execCalls };
}

test("--mode, --voice and --priority end up in the event", async () => {
  const h = harness();
  const code = await run(
    ["say", "hi", "--mode", "full", "--voice", "Samantha", "--priority", "high"],
    h.io,
    h.deps,
  );
  expect(code).toBe(0);
  expect(h.spoken[0]).toEqual({
    text: "hi",
    source: "cli",
    kind: "response",
    format: "markdown",
    mode: "full",
    voice: "Samantha",
    priority: "high",
  });
});

test("omitted flags are not sent", async () => {
  const h = harness();
  expect(await run(["say", "hi"], h.io, h.deps)).toBe(0);
  expect(Object.keys(h.spoken[0] ?? {}).sort()).toEqual(["format", "kind", "source", "text"]);
});

test.each([
  [["--priority", "urgent"], "--priority"],
  [["--mode", "loud"], "--mode"],
])("invalid %p exits 2", async (flags, name) => {
  const h = harness();
  expect(await run(["say", "hi", ...flags], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain(name);
  expect(h.spoken).toEqual([]);
});

test("--file with .md speaks markdown", async () => {
  const path = join(dir, "notes.md");
  writeFileSync(path, "# Title\n\nSome **bold** text.\n");
  const h = harness();
  expect(await run(["say", "--file", path], h.io, h.deps)).toBe(0);
  expect(h.spoken[0]).toMatchObject({
    text: "# Title\n\nSome **bold** text.",
    format: "markdown",
  });
});

test("--file with .markdown speaks markdown", async () => {
  const path = join(dir, "notes.markdown");
  writeFileSync(path, "hello");
  const h = harness();
  expect(await run(["say", "--file", path], h.io, h.deps)).toBe(0);
  expect(h.spoken[0]?.format).toBe("markdown");
});

test("--file with .txt speaks plain, unless --markdown is given", async () => {
  const path = join(dir, "notes.txt");
  writeFileSync(path, "plain **words**\n");
  const h = harness();
  expect(await run(["say", "--file", path], h.io, h.deps)).toBe(0);
  expect(h.spoken[0]).toMatchObject({ text: "plain **words**", format: "plain" });
  expect(await run(["say", "--file", path, "--markdown"], h.io, h.deps)).toBe(0);
  expect(h.spoken[1]?.format).toBe("markdown");
});

test("--file that cannot be read exits 2", async () => {
  const h = harness();
  expect(await run(["say", "--file", join(dir, "missing.md")], h.io, h.deps)).toBe(2);
  expect(h.err.join("")).toContain("missing.md");
});

test("--file with positional text is a usage error", async () => {
  const path = join(dir, "notes.md");
  writeFileSync(path, "hello");
  const h = harness();
  expect(await run(["say", "--file", path, "extra"], h.io, h.deps)).toBe(2);
  expect(h.spoken).toEqual([]);
});

test("--fallback-say speaks cleaned text locally through exec and removes the temp file", async () => {
  const h = harness({ unreachable: true });
  const code = await run(["say", "--fallback-say", "## Done\nI **fixed** the bug."], h.io, h.deps);
  expect(code).toBe(0);
  expect(h.execCalls).toHaveLength(1);
  const call = h.execCalls[0];
  expect(call?.cmd.slice(0, 2)).toEqual(["/usr/bin/say", "-f"]);
  const tmp = call?.cmd[2] ?? "";
  expect(call?.cmd).toHaveLength(3);
  expect(call?.fileText).toBe("Done. I fixed the bug.");
  expect(existsSync(tmp)).toBe(false);
  expect(h.err.join("")).toContain("spoke locally (daemon unreachable)");
});

test("--fallback-say with --plain writes the raw text", async () => {
  const h = harness({ unreachable: true });
  expect(await run(["say", "--fallback-say", "--plain", "**raw**"], h.io, h.deps)).toBe(0);
  expect(h.execCalls[0]?.fileText).toBe("**raw**");
});

test("--fallback-say is not used when the daemon answers", async () => {
  const h = harness();
  expect(await run(["say", "--fallback-say", "hi"], h.io, h.deps)).toBe(0);
  expect(h.execCalls).toEqual([]);
  expect(h.spoken).toHaveLength(1);
});

test("--fallback-say reports a failing local say and exits 1", async () => {
  const h = harness({ unreachable: true, execCode: 1 });
  expect(await run(["say", "--fallback-say", "hi"], h.io, h.deps)).toBe(1);
  expect(h.execCalls).toHaveLength(1);
  expect(h.execCalls[0]?.fileText).toBe("hi.");
  expect(existsSync(h.execCalls[0]?.cmd[2] ?? "")).toBe(false);
  expect(h.err.join("")).toContain("local say failed");
});

test("without --fallback-say an unreachable daemon exits 1 with a hint", async () => {
  const h = harness({ unreachable: true });
  expect(await run(["say", "hi"], h.io, h.deps)).toBe(1);
  const err = h.err.join("");
  expect(err).toContain("unreachable");
  expect(err).toContain("start it with `mouthpiece start` or `./install.sh`");
  expect(h.execCalls).toEqual([]);
});
