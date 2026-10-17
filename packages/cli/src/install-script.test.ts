// install-script.test.ts: dry run only; never executes real installation steps.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-install-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function dryRun(script: string) {
  const proc = Bun.spawn(["bash", join(REPO, script)], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      BUN: process.execPath,
      MOUTHPIECE_DRY_RUN: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await proc.exited,
    out: await new Response(proc.stdout).text(),
    err: await new Response(proc.stderr).text(),
  };
}

test.each(["install.sh", "uninstall.sh"])("%s parses", async (script) => {
  expect(await Bun.spawn(["bash", "-n", join(REPO, script)]).exited).toBe(0);
});

test("install.sh dry run plans every step and writes nothing", async () => {
  const r = await dryRun("install.sh");
  expect(r.code).toBe(0);
  for (const step of [
    "install",
    "build-hotkeys",
    "install-hooks",
    "install-agent",
    "Mouthpiece is ready",
  ])
    expect(r.out).toContain(step);
  expect(await readdir(home)).toEqual([]);
});

test("uninstall.sh dry run plans removal and writes nothing", async () => {
  const r = await dryRun("uninstall.sh");
  expect(r.code).toBe(0);
  for (const step of ["uninstall-agent", "uninstall-hooks"]) expect(r.out).toContain(step);
  expect(await readdir(home)).toEqual([]);
});
