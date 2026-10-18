import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mouthpieceHome } from "@mouthpiece/core";
import { isKokoroInstalled, kokoroHome } from "@mouthpiece/providers";
import type { CliDeps, CliIO, CommandFn } from "../types.ts";

export const KOKORO_PACKAGE = "kokoro-js@1.2.1";
const USAGE = "usage: mouthpiece kokoro install | status | uninstall";

/** `mouthpiece kokoro install | status | uninstall` (US-019). */
export const kokoroCommand: CommandFn = async (args, io, deps) => {
  const home = mouthpieceHome(deps.env);
  const dir = kokoroHome(home);
  switch (args[0]) {
    case "install":
      return install(io, deps, home, dir);
    case "status":
      return status(io, home, dir);
    case "uninstall": {
      // Only ever <home>/kokoro: kokoroHome() always appends "kokoro" to the home dir.
      const r = await deps.exec(["rm", "-rf", dir]);
      if (r.code !== 0) {
        io.err(`mouthpiece: removing ${dir} failed: ${r.stderr.trim()}\n`);
        return 1;
      }
      io.out(`Removed ${dir}. Remove "kokoro" from [provider].chain in config.toml.\n`);
      return 0;
    }
    default:
      io.err(`${USAGE}\n`);
      return 2;
  }
};

async function install(io: CliIO, deps: CliDeps, home: string, dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) {
    await writeFile(
      pkg,
      `${JSON.stringify({ name: "mouthpiece-kokoro", private: true, type: "module" }, null, 2)}\n`,
    );
  }
  io.out(`Installing ${KOKORO_PACKAGE} into ${dir} (about 400 MB)…\n`);
  const added = await deps.exec([deps.paths.bun, "add", KOKORO_PACKAGE], { cwd: dir });
  if (added.code !== 0) {
    io.err(`mouthpiece: bun add ${KOKORO_PACKAGE} failed: ${added.stderr.trim()}\n`);
    return 1;
  }
  io.out("Downloading the model (about 92 MB) and warming up…\n");
  const warm = await deps.exec(
    [deps.paths.bun, join(deps.paths.repoRoot, "scripts/kokoro-warm.ts")],
    {
      env: { ...deps.env, MOUTHPIECE_HOME: home },
    },
  );
  // The timing line is the success signal: Bun can crash on exit after onnxruntime has loaded
  // (exit 134, "A C++ exception occurred") although the warm-up itself finished.
  const timing = parseTiming(warm.stdout);
  if (!timing) {
    const why = warm.stderr.trim() || `exit code ${warm.code}, no timing line`;
    io.err(`mouthpiece: Kokoro warm-up failed: ${why}\n`);
    return 1;
  }
  if (warm.code !== 0) {
    io.err(
      `mouthpiece: note: the Kokoro warm-up finished but exited with exit code ${warm.code}: ${warm.stderr.trim()}\n`,
    );
  }
  io.out(`Kokoro is ready (load ${timing.loadMs} ms, first phrase ${timing.generateMs} ms).\n`);
  io.out('Add "kokoro" to [provider].chain in config.toml, e.g. chain = ["kokoro", "say"].\n');
  return 0;
}

async function status(io: CliIO, home: string, dir: string): Promise<number> {
  if (!isKokoroInstalled(home)) {
    io.out(`Kokoro: not installed. Run: mouthpiece kokoro install\n`);
    return 0;
  }
  const version = await readVersion(join(dir, "node_modules", "kokoro-js", "package.json"));
  const cache = await dirSize(join(dir, "hf"));
  io.out(
    `Kokoro: installed at ${dir}\n` +
      `  kokoro-js ${version ?? "(unknown version)"}\n` +
      `  model cache ${formatMB(cache)}${cache === 0 ? " (no model yet; run mouthpiece kokoro install)" : ""}\n`,
  );
  return 0;
}

function parseTiming(stdout: string): { loadMs: number; generateMs: number } | undefined {
  const last = stdout.trim().split("\n").at(-1);
  try {
    const t = JSON.parse(last ?? "");
    if (typeof t.loadMs === "number" && typeof t.generateMs === "number") return t;
  } catch {}
  return undefined;
}

async function readVersion(path: string): Promise<string | undefined> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Total bytes of regular files under `path`; 0 when it doesn't exist. Doesn't follow symlinks. */
async function dirSize(path: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const child = join(path, e.name);
    if (e.isDirectory()) total += await dirSize(child);
    else if (e.isFile()) total += (await stat(child)).size;
  }
  return total;
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
