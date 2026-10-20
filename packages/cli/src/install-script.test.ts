// install-script.test.ts: dry run only; never executes real installation steps.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

async function dryRun(script: string, path = process.env.PATH ?? "") {
  const proc = Bun.spawn(["bash", join(REPO, script)], {
    env: {
      PATH: path,
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
    "Building helper (hotkeys, menubar, mic pause)",
    "build-helper",
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
  for (const step of ["uninstall-agent", "uninstall-hooks", "auth inworld --delete", "rm -rf"])
    expect(r.out).toContain(step);
  expect(await readdir(home)).toEqual([]);
});

test("uninstall.sh deletes the Keychain key before removing the CLI link it runs through", async () => {
  const r = await dryRun("uninstall.sh");
  const lines = r.out.split("\n");
  const auth = lines.findIndex((l) => l.includes("auth inworld --delete"));
  const unlink = lines.findIndex(
    (l) => l.startsWith("+ rm -f") && l.includes(".local/bin/mouthpiece"),
  );
  expect(auth).toBeGreaterThanOrEqual(0);
  expect(unlink).toBeGreaterThan(auth);
});

/** process.env.PATH without any directory that holds a `codex`, `gemini` or `devin` (this machine may have them). */
function pathWithoutAgents(): string {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(
      (d) =>
        d &&
        !existsSync(join(d, "codex")) &&
        !existsSync(join(d, "gemini")) &&
        !existsSync(join(d, "devin")),
    )
    .join(":");
}

/** A temp dir holding fake executables, prepended to the agent-free PATH. */
async function pathWith(...tools: string[]): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "mp-fakebin-"));
  fakeBins.push(bin);
  for (const tool of tools) {
    await writeFile(join(bin, tool), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, tool), 0o755);
  }
  return `${bin}:${pathWithoutAgents()}`;
}
const fakeBins: string[] = [];
afterEach(async () => {
  for (const bin of fakeBins.splice(0)) await rm(bin, { recursive: true, force: true });
});

test("install.sh installs Codex hooks only when codex is on PATH", async () => {
  const withCodex = await dryRun("install.sh", await pathWith("codex"));
  expect(withCodex.code).toBe(0);
  expect(withCodex.out).toContain("install-hooks --target codex");
  expect(withCodex.out).toContain("/hooks");
  expect(withCodex.out).not.toContain("install-hooks --target gemini");
  expect(await readdir(home)).toEqual([]);

  const without = await dryRun("install.sh", pathWithoutAgents());
  expect(without.code).toBe(0);
  expect(without.out).not.toContain("install-hooks --target codex");
  expect(without.out).not.toContain("install-hooks --target gemini");
  expect(without.out).toContain("install-hooks");
});

test("install.sh installs Gemini hooks only when gemini is on PATH", async () => {
  const r = await dryRun("install.sh", await pathWith("gemini"));
  expect(r.code).toBe(0);
  expect(r.out).toContain("install-hooks --target gemini");
  expect(r.out).not.toContain("install-hooks --target codex");
  expect(await readdir(home)).toEqual([]);
});

test("install.sh installs Devin hooks only when devin is on PATH", async () => {
  const withDevin = await dryRun("install.sh", await pathWith("devin"));
  expect(withDevin.code).toBe(0);
  expect(withDevin.out).toContain("install-hooks --target devin");
  expect(withDevin.out).not.toContain("install-hooks --target codex");
  expect(await readdir(home)).toEqual([]);

  const without = await dryRun("install.sh", pathWithoutAgents());
  expect(without.out).not.toContain("install-hooks --target devin");
});

test("install.sh treats a failed Codex, Gemini or Devin hook install as non-fatal", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  for (const target of ["codex", "gemini", "devin"]) {
    const line = script
      .split("\n")
      .find((l) => l.includes(`install-hooks --target ${target}`) && l.includes("run "));
    expect(line).toMatch(new RegExp(`--target ${target} \\|\\| `));
  }
});

test("uninstall.sh dry run removes hooks for all four targets", async () => {
  const r = await dryRun("uninstall.sh", pathWithoutAgents());
  expect(r.code).toBe(0);
  for (const target of ["claude-code", "codex", "gemini", "devin"])
    expect(r.out).toContain(`uninstall-hooks --target ${target}`);
  expect(await readdir(home)).toEqual([]);
});

test("install.sh treats a failed helper build as non-fatal", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  const line = script.split("\n").find((l) => l.includes("build-helper") && l.includes("run "));
  expect(line).toMatch(/build-helper \|\| /);
});

test("install.sh dry run plans the Kokoro install, the default voice, before the optional key (US-019)", async () => {
  const r = await dryRun("install.sh");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Local Kokoro voice (the default voice)");
  const plan = r.out.split("\n").find((l) => l.includes("kokoro install"));
  expect(plan).toBe(`+ ${home}/.local/bin/mouthpiece kokoro install`);
  expect(r.out).not.toContain("[Y/n]");
  expect(r.out.indexOf("kokoro install")).toBeLessThan(r.out.indexOf("TTS provider key"));
  expect(await readdir(home)).toEqual([]);
});

test("install.sh installs Kokoro unless you answer no, asking only on a terminal outside a dry run", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  expect(script).toContain('if [ -t 0 ] && [ "$DRY_RUN" != 1 ]; then');
  expect(script).toContain("Install the free local Kokoro voice (~500 MB)? [Y/n]");
  const line = script.split("\n").find((l) => l.includes("kokoro install") && l.includes("run "));
  // A failed Kokoro install leaves the rest of the install (and macOS say) working.
  expect(line).toMatch(/kokoro install \|\| /);
});

test("uninstall.sh dry run removes the helper app and asks before removing Kokoro", async () => {
  const r = await dryRun("uninstall.sh");
  expect(r.code).toBe(0);
  const lines = r.out.split("\n");
  expect(lines).toContain(`+ rm -rf '${home}/.mouthpiece/MouthpieceHelper.app'`);
  const ask = lines.findIndex((l) => l.startsWith("? Delete the Kokoro voice"));
  expect(ask).toBeGreaterThanOrEqual(0);
  expect(lines[ask]).toContain("(dry run: planning yes)");
  expect(lines[ask + 1]).toBe(`+ rm -rf '${home}/.mouthpiece/kokoro'`);
  expect(await readdir(home)).toEqual([]);
});

/** The exact `bash -c` command install.sh runs to write the CLI wrapper, from its dry-run plan. */
async function wrapperCommand(): Promise<string> {
  const r = await dryRun("install.sh");
  const prefix = "+ bash -c ";
  const line = r.out
    .split("\n")
    .find(
      (l) => l.startsWith(prefix) && l.includes("printf") && l.includes("/.local/bin/mouthpiece"),
    );
  expect(line).toBeDefined();
  return (line ?? "").slice(prefix.length);
}

test("install.sh's CLI wrapper pins the repo's bunfig.toml and skips .env files", async () => {
  const command = await wrapperCommand();
  expect(command).toContain('exec "%s" --config="%s" --no-env-file "%s" "$@"');
  expect(command).toContain(`'${REPO}/bunfig.toml' '${REPO}/packages/cli/src/main.ts'`);
  expect(await readdir(home)).toEqual([]);
});

test("the wrapper install.sh writes runs the CLI unaffected by a project bunfig.toml", async () => {
  // Run install.sh's own wrapper-writing command; its target is inside the temp HOME.
  const command = await wrapperCommand();
  expect(command).toContain(`'${home}/.local/bin/mouthpiece'`);
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  expect(await Bun.spawn(["bash", "-c", command]).exited).toBe(0);
  const project = await mkdtemp(join(tmpdir(), "mp-hostile-"));
  fakeBins.push(project);
  await writeFile(join(project, "bunfig.toml"), 'preload = ["./p.ts"]\n');
  await writeFile(join(project, "p.ts"), 'console.log("preloaded");\n');
  await writeFile(join(project, ".env"), "MOUTHPIECE_HOME=/nonexistent\n");
  const proc = Bun.spawn([join(home, ".local", "bin", "mouthpiece"), "--help"], {
    cwd: project,
    env: { PATH: process.env.PATH ?? "", HOME: home, MOUTHPIECE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  expect(out + err).not.toContain("preloaded");
  expect(out + err).toStartWith("usage: mouthpiece");
});
