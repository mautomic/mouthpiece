// hook-command.test.ts: the installed hook command lines must stay silent and exit 0 even when the
// host tool runs them inside a project whose bunfig.toml would make Bun print or fail (FR-2).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hookMainFor, TARGETS, type TargetName } from "./hook-targets.ts";

const REPO = resolve(import.meta.dir, "../../..");
let project: string;
let home: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "mp-hostile-project-"));
  home = await mkdtemp(join(tmpdir(), "mp-hook-home-"));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** The first command line installed for the target, exactly as the host tool would see it. */
function installedCommand(name: TargetName): string {
  const groups = TARGETS[name].groups({
    bun: process.execPath,
    hookMain: hookMainFor(REPO, name),
    idleAlerts: false,
  });
  const hook = Object.values(groups)[0]?.[0]?.hooks[0] as { command: string };
  return hook.command;
}

/** Runs it the way Claude Code, Codex and Gemini do: through a shell, with cwd at the project. */
async function runFromProject(command: string) {
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: project,
    stdin: new TextEncoder().encode("{}"),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      MOUTHPIECE_HOME: home,
      MOUTHPIECE_TOKEN: "t",
      MOUTHPIECE_URL: "http://127.0.0.1:1",
    },
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

const NAMES = ["claude-code", "codex", "gemini", "devin"] as const;

test.each(NAMES)("%s hook ignores a project bunfig.toml whose preload logs", async (name) => {
  await writeFile(join(project, "bunfig.toml"), 'preload = ["./p.ts"]\n');
  await writeFile(join(project, "p.ts"), 'console.log("preloaded"); console.error("noise");\n');
  await writeFile(join(project, ".env"), "MOUTHPIECE_URL=http://127.0.0.1:2\n");
  expect(await runFromProject(installedCommand(name))).toEqual({ code: 0, stdout: "", stderr: "" });
});

test.each(NAMES)("%s hook ignores a malformed project bunfig.toml", async (name) => {
  await writeFile(join(project, "bunfig.toml"), "preload = [\n");
  expect(await runFromProject(installedCommand(name))).toEqual({ code: 0, stdout: "", stderr: "" });
});

test.each(NAMES)("%s hook ignores a project bunfig.toml whose preload is missing", async (name) => {
  await writeFile(join(project, "bunfig.toml"), 'preload = ["./missing.ts"]\n');
  expect(await runFromProject(installedCommand(name))).toEqual({ code: 0, stdout: "", stderr: "" });
});
