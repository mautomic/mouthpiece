import { join } from "node:path";
import { AGENT_LABEL, guiDomain, launchAgentsDir } from "../launchd.ts";
import type { CliDeps, CliIO, CommandFn } from "../types.ts";

const USAGE = "usage: mouthpiece daemon start | stop | restart\n";

/**
 * Starts, stops, or restarts the installed launchd agent without uninstalling it. A stopped daemon
 * starts again at the next login (the plist stays), and hooks stay silent while it is down.
 */
export const daemonCommand: CommandFn = async (args, io, deps) => {
  const [sub, ...rest] = args;
  if (rest.length > 0 || (sub !== "start" && sub !== "stop" && sub !== "restart")) {
    io.err(USAGE);
    return 2;
  }
  const service = `${guiDomain()}/${AGENT_LABEL}`;
  const plistPath = join(launchAgentsDir(deps.env), `${AGENT_LABEL}.plist`);
  if (sub !== "stop" && !(await Bun.file(plistPath).exists())) {
    io.err("mouthpiece: the daemon is not installed; run `mouthpiece install-agent`\n");
    return 1;
  }
  const print = await deps.exec(["launchctl", "print", service]);
  const loaded = print.code === 0;
  // Loaded but not running: it exited cleanly (the menubar's Quit) and launchd left it stopped.
  // If print's wording ever changes, start falls back to kickstart, which is harmless when running.
  const running = loaded && /^\s*state = running$/m.test(print.stdout);

  if (sub === "stop") {
    // Unload whenever it's loaded, running or not; this doesn't depend on print's wording.
    if (!loaded) {
      io.out("Daemon is not running.\n");
      return 0;
    }
    if (!(await launchctl(deps, io, ["bootout", service]))) return 1;
    io.out("Daemon stopped. It starts again at login, or with `mouthpiece daemon start`.\n");
    return 0;
  }
  // The agent is stopped but something else owns the port: a foreground `mouthpiece start` or a
  // stale daemon. Starting the agent against it would crash-loop on the same port.
  if (!running) {
    const listening = await deps.client.health().then(
      () => true,
      () => false,
    );
    if (listening) {
      io.err(
        "mouthpiece: a daemon is already listening, but not through launchd; stop it first (e.g. Ctrl-C on `mouthpiece start`).\n",
      );
      return 1;
    }
  }
  if (sub === "restart" && loaded) {
    if (!(await launchctl(deps, io, ["kickstart", "-k", service]))) return 1;
    io.out("Daemon restarted.\n");
    return 0;
  }
  if (running) {
    io.out("Daemon is already running.\n");
    return 0;
  }
  if (loaded) {
    if (!(await launchctl(deps, io, ["kickstart", service]))) return 1;
    io.out("Daemon started.\n");
    return 0;
  }
  if (!(await launchctl(deps, io, ["bootstrap", guiDomain(), plistPath]))) return 1;
  io.out("Daemon started.\n");
  return 0;
};

/** Runs `launchctl <args>`; on failure prints its stderr and returns false. */
async function launchctl(deps: CliDeps, io: CliIO, args: string[]): Promise<boolean> {
  const result = await deps.exec(["launchctl", ...args]);
  if (result.code === 0) return true;
  io.err(`mouthpiece: launchctl ${args[0]} failed: ${result.stderr.trim()}\n`);
  return false;
}
