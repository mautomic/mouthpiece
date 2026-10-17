import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
let project: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "mp-dev-settings-"));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

async function devSettings(): Promise<{
  hooks: Record<string, { hooks: { command: string }[] }[]>;
}> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "dev-settings.ts")], {
    cwd: REPO,
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(0);
  return JSON.parse(await new Response(proc.stdout).text());
}

test("dev settings pin the repo's bunfig.toml and skip .env files", async () => {
  const { hooks } = await devSettings();
  const command = hooks.Stop?.[0]?.hooks[0]?.command;
  expect(command).toBe(
    `${JSON.stringify(process.execPath)} --config=${JSON.stringify(join(REPO, "bunfig.toml"))} --no-env-file ${JSON.stringify(join(import.meta.dir, "main.ts"))} stop`,
  );
});

test("dev settings hooks stay silent inside a project with a hostile bunfig.toml", async () => {
  await writeFile(join(project, "bunfig.toml"), 'preload = ["./p.ts"]\n');
  await writeFile(join(project, "p.ts"), 'console.log("preloaded");\n');
  const { hooks } = await devSettings();
  const command = hooks.Stop?.[0]?.hooks[0]?.command ?? "";
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: project,
    stdin: new TextEncoder().encode("{}"),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      MOUTHPIECE_HOME: project,
      MOUTHPIECE_TOKEN: "t",
      MOUTHPIECE_URL: "http://127.0.0.1:1",
    },
  });
  expect({
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }).toEqual({ code: 0, stdout: "", stderr: "" });
});
