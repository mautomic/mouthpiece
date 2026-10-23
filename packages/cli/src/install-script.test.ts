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

async function dryRun(
  script: string,
  path = process.env.PATH ?? "",
  bun: string | null = process.execPath,
  args: string[] = [],
) {
  const env: Record<string, string> = {
    PATH: path,
    HOME: home,
    MOUTHPIECE_DRY_RUN: "1",
  };
  if (bun !== null) env.BUN = bun;
  const proc = Bun.spawn(["bash", join(REPO, script), ...args], {
    env,
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

test("install.sh defaults to a local CLI setup without integrations", async () => {
  const r = await dryRun("install.sh");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Installing dependencies");
  for (const integration of ["build-helper", "kokoro install", "install-hooks", "install-agent"])
    expect(r.out).not.toContain(integration);
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

/** process.env.PATH without any directory that holds one of `tools` (this machine may have them). */
function pathWithout(...tools: string[]): string {
  return (process.env.PATH ?? "")
    .split(":")
    .filter((d) => d && !tools.some((t) => existsSync(join(d, t))))
    .join(":");
}

/** process.env.PATH without any directory that holds a `claude`, `codex`, `gemini` or `devin`. */
function pathWithoutAgents(): string {
  return pathWithout("claude", "codex", "gemini", "devin");
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

const FAKE_BUN_SCRIPT = (version: string) => `#!/bin/sh
case "$2" in
  *Bun.version*) printf '%s\\n' '${version}' ;;
  *) printf '%s\\n' arm64 ;;
esac
`;

/** A fake native Bun that reports the supplied version. */
async function fakeBun(version: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "mp-fakebun-"));
  fakeBins.push(bin);
  const bun = join(bin, "bun");
  await writeFile(bun, FAKE_BUN_SCRIPT(version));
  await chmod(bun, 0o755);
  return bun;
}

/** A PATH whose first entry holds a fake `bun` reporting the supplied version. */
async function pathWithFakeBun(version: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "mp-fakebun-"));
  fakeBins.push(bin);
  await writeFile(join(bin, "bun"), FAKE_BUN_SCRIPT(version));
  await chmod(join(bin, "bun"), 0o755);
  return `${bin}:${pathWithoutAgents()}`;
}

test("install.sh rejects Bun older than 1.2 before changing the user's home", async () => {
  const r = await dryRun("install.sh", process.env.PATH ?? "", await fakeBun("1.1.99"));
  expect(r.code).toBe(1);
  expect(r.err).toContain("requires Bun 1.2 or later");
  expect(await readdir(home)).toEqual([]);
});

test("install.sh uses a Bun already on PATH instead of installing one", async () => {
  const r = await dryRun("install.sh", await pathWithFakeBun("1.4.2"), null);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("bun.sh/install");
  expect(r.out).toContain("install --frozen-lockfile");
});

test("install.sh plans the Bun download only when no Bun is found", async () => {
  const r = await dryRun("install.sh", pathWithout("bun"), null);
  expect(r.code).toBe(0);
  expect(r.out).toContain("Bun not found");
  expect(r.out).toContain("bun.sh/install");
});

test("install.sh requires Apple Silicon", async () => {
  const bin = await mkdtemp(join(tmpdir(), "mp-fake-uname-"));
  fakeBins.push(bin);
  await writeFile(
    join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; *) echo x86_64 ;; esac\n',
  );
  await chmod(join(bin, "uname"), 0o755);
  const r = await dryRun("install.sh", `${bin}:/usr/bin:/bin`, null);
  expect(r.code).toBe(1);
  expect(r.err).toContain("Apple Silicon");
  expect(await readdir(home)).toEqual([]);
});

test("install.sh smoke-checks the CLI wrapper it writes", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  // `--help` exits 2 by design; the check must match its output, not its status.
  expect(script).toContain('"$MP" --help');
  expect(script).toContain("usage: mouthpiece");
});

test("install.sh treats a failed Claude Code hook install as non-fatal", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  const line = script
    .split("\n")
    .find((l) => l.includes('run "$MP" install-hooks') && !l.includes("--target"));
  expect(line).toMatch(/install-hooks \|\| /);
});

test("install.sh --with-hooks says when no supported tool is on PATH", async () => {
  const r = await dryRun("install.sh", pathWithoutAgents(), process.execPath, ["--with-hooks"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("No supported tools");
});

test("install.sh installs the committed dependency graph", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  expect(script).toContain('run "$BUN" install --frozen-lockfile');
});

test("install.sh writes a commented config template only when none exists", async () => {
  const r = await runInstall("/usr/bin:/bin", await fakeBun("1.4.2"));
  expect(r.code).toBe(0);
  const cfg = join(home, ".config", "mouthpiece", "config.toml");
  // The template is comments only, so it parses to the defaults — nothing is pinned.
  expect(Bun.TOML.parse(await readFile(cfg, "utf8"))).toEqual({});

  await writeFile(cfg, '# mine\n[modes]\ndefault = "full"\n');
  const again = await runInstall("/usr/bin:/bin", await fakeBun("1.4.2"));
  expect(again.code).toBe(0);
  expect(await readFile(cfg, "utf8")).toBe('# mine\n[modes]\ndefault = "full"\n');
});

test("install.sh honors MOUTHPIECE_CONFIG for the template", async () => {
  const cfg = join(home, "elsewhere.toml");
  const proc = Bun.spawn(["bash", join(REPO, "install.sh")], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      BUN: await fakeBun("1.4.2"),
      MOUTHPIECE_DRY_RUN: "0",
      MOUTHPIECE_CONFIG: cfg,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  expect(Bun.TOML.parse(await readFile(cfg, "utf8"))).toEqual({});
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
  const withCodex = await dryRun("install.sh", await pathWith("codex"), process.execPath, [
    "--with-hooks",
  ]);
  expect(withCodex.code).toBe(0);
  expect(withCodex.out).toContain("install-hooks --target codex");
  expect(withCodex.out).toContain("/hooks");
  expect(withCodex.out).not.toContain("install-hooks --target gemini");
  expect(await readdir(home)).toEqual([]);

  const without = await dryRun("install.sh", pathWithoutAgents(), process.execPath, [
    "--with-hooks",
  ]);
  expect(without.code).toBe(0);
  expect(without.out).not.toContain("install-hooks");
});

test("install.sh installs Claude Code hooks only when claude is on PATH", async () => {
  const withClaude = await dryRun("install.sh", await pathWith("claude"), process.execPath, [
    "--with-hooks",
  ]);
  expect(withClaude.code).toBe(0);
  expect(withClaude.out).toContain("Claude Code hooks");
  const plan = withClaude.out.split("\n").find((l) => l.includes("install-hooks"));
  expect(plan?.trim()).toBe(`+ ${home}/.local/bin/mouthpiece install-hooks`);

  const without = await dryRun("install.sh", pathWithoutAgents(), process.execPath, [
    "--with-hooks",
  ]);
  expect(without.code).toBe(0);
  expect(without.out).not.toContain("install-hooks");
});

test("install.sh installs Gemini hooks only when gemini is on PATH", async () => {
  const r = await dryRun("install.sh", await pathWith("gemini"), process.execPath, [
    "--with-hooks",
  ]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("install-hooks --target gemini");
  expect(r.out).not.toContain("install-hooks --target codex");
  expect(await readdir(home)).toEqual([]);
});

test("install.sh installs Devin hooks only when devin is on PATH", async () => {
  const withDevin = await dryRun("install.sh", await pathWith("devin"), process.execPath, [
    "--with-hooks",
  ]);
  expect(withDevin.code).toBe(0);
  expect(withDevin.out).toContain("install-hooks --target devin");
  expect(withDevin.out).not.toContain("install-hooks --target codex");
  expect(await readdir(home)).toEqual([]);

  const without = await dryRun("install.sh", pathWithoutAgents(), process.execPath, [
    "--with-hooks",
  ]);
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

test("uninstall.sh treats a failed Claude Code hook removal as non-fatal", async () => {
  const script = await Bun.file(join(REPO, "uninstall.sh")).text();
  const line = script.split("\n").find((l) => l.includes("uninstall-hooks --target claude-code"));
  expect(line).toMatch(/\|\| /);
});

test("uninstall.sh still removes files when neither the CLI link nor Bun exists", async () => {
  const script = await Bun.file(join(REPO, "uninstall.sh")).text();
  expect(script).toMatch(/elif \[ -x "\$BUN" \]/);
  const r = await dryRun("uninstall.sh", pathWithout("bun"), "/nonexistent/bun");
  expect(r.code).toBe(0);
  expect(r.out).toContain("skipping");
  expect(r.out).toContain("rm -rf");
});

test("uninstall.sh dry run removes hooks for all four targets", async () => {
  const r = await dryRun("uninstall.sh", pathWithoutAgents());
  expect(r.code).toBe(0);
  for (const target of ["claude-code", "codex", "gemini", "devin"])
    expect(r.out).toContain(`uninstall-hooks --target ${target}`);
  expect(await readdir(home)).toEqual([]);
});

test("uninstall.sh's CLI fallback pins the repo's bunfig.toml and skips .env files", async () => {
  // The temp home has no ~/.local/bin/mouthpiece, so every mp() call plans the Bun fallback.
  const r = await dryRun("uninstall.sh");
  expect(r.code).toBe(0);
  const lines = r.out.split("\n").filter((l) => l.includes("packages/cli/src/main.ts"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toContain(`--config=${REPO}/bunfig.toml`);
    expect(line).toContain("--no-env-file");
  }
});

test("install.sh treats a failed agent install as non-fatal", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  const line = script.split("\n").find((l) => l.includes("install-agent") && l.includes("run "));
  expect(line).toMatch(/install-agent \|\| /);
});

test("install.sh treats a failed helper build as non-fatal", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  const line = script.split("\n").find((l) => l.includes("build-helper") && l.includes("run "));
  expect(line).toMatch(/build-helper \|\| /);
});

test("install.sh plans the Kokoro download only when requested (US-019)", async () => {
  const r = await dryRun("install.sh", process.env.PATH ?? "", process.execPath, ["--with-kokoro"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("Local Kokoro voice");
  const plan = r.out.split("\n").find((l) => l.includes("kokoro install"));
  expect(plan?.trim()).toBe(`+ ${home}/.local/bin/mouthpiece kokoro install`);
  expect(r.out).not.toContain("[Y/n]");
  expect(await readdir(home)).toEqual([]);
});

test("install.sh installs Kokoro only when explicitly requested", async () => {
  const script = await Bun.file(join(REPO, "install.sh")).text();
  expect(script).toContain('if [ "$WITH_KOKORO" = 1 ]; then');
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
