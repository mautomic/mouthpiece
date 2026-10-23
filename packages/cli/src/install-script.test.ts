// install-script.test.ts: dry run only; never executes real installation steps.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function dryRun(script: string, path = process.env.PATH ?? "", bun = process.execPath) {
  const proc = Bun.spawn(["bash", join(REPO, script)], {
    env: {
      PATH: path,
      HOME: home,
      BUN: bun,
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

async function runInstall(path: string, bun: string) {
  const proc = Bun.spawn(["bash", join(REPO, "install.sh")], {
    env: { PATH: path, HOME: home, BUN: bun, MOUTHPIECE_DRY_RUN: "0" },
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
    "==> Testing",
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

/** A fake native Bun that reports the supplied version. */
async function fakeBun(version: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "mp-fakebun-"));
  fakeBins.push(bin);
  const bun = join(bin, "bun");
  await writeFile(
    bun,
    `#!/bin/sh
case "$2" in
  *Bun.version*) printf '%s\\n' '${version}' ;;
  *) printf '%s\\n' arm64 ;;
esac
`,
  );
  await chmod(bun, 0o755);
  return bun;
}

test("install.sh rejects Bun older than 1.2 before changing the user's home", async () => {
  const r = await dryRun("install.sh", process.env.PATH ?? "", await fakeBun("1.1.99"));
  expect(r.code).toBe(1);
  expect(r.err).toContain("requires Bun 1.2 or later");
  expect(await readdir(home)).toEqual([]);
});

test("install.sh works when HOME contains spaces and apostrophes", async () => {
  const base = home;
  home = join(base, "Mau's tools");
  await mkdir(home);
  const r = await runInstall("/usr/bin:/bin", await fakeBun("1.4.2"));
  expect(r.code).toBe(0);
  const wrapper = join(home, ".local", "bin", "mouthpiece");
  expect(existsSync(wrapper)).toBe(true);
  expect(await readFile(wrapper, "utf8")).toContain("--no-env-file");
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
  expect(plan?.trim()).toBe(`+ ${home}/.local/bin/mouthpiece kokoro install`);
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
  expect(
    lines.some((line) => line.startsWith(`+ rm -rf ${home}/.mouthpiece/MouthpieceHelper.app`)),
  ).toBe(true);
  const ask = lines.findIndex((l) => l.startsWith("? Delete the Kokoro voice"));
  expect(ask).toBeGreaterThanOrEqual(0);
  expect(lines[ask]).toContain("(dry run: planning yes)");
  expect(lines[ask + 1]?.trim()).toBe(`+ rm -rf ${home}/.mouthpiece/kokoro`);
  expect(await readdir(home)).toEqual([]);
});

test("install.sh's CLI wrapper pins the repo's bunfig.toml and skips .env files", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  expect(script).toContain('exec "%s" --config="%s" --no-env-file "%s" "$@"');
  expect(script).not.toContain("eval");
});

test("the wrapper install.sh writes runs the CLI unaffected by a project bunfig.toml", async () => {
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  const wrapper = join(home, ".local", "bin", "mouthpiece");
  await writeFile(
    wrapper,
    `#!/usr/bin/env bash\nexec "${process.execPath}" --config="${REPO}/bunfig.toml" --no-env-file "${REPO}/packages/cli/src/main.ts" "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  const project = await mkdtemp(join(tmpdir(), "mp-hostile-"));
  fakeBins.push(project);
  await writeFile(join(project, "bunfig.toml"), 'preload = ["./p.ts"]\n');
  await writeFile(join(project, "p.ts"), 'console.log("preloaded");\n');
  await writeFile(join(project, ".env"), "MOUTHPIECE_HOME=/nonexistent\n");
  const proc = Bun.spawn([wrapper, "--help"], {
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
