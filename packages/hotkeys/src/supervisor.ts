import type { Logger } from "@mouthpiece/core";

export type SpawnFn = (cmd: string[]) => { exited: Promise<number>; kill(): void };

export interface SupervisorOptions {
  binary: string;
  args: string[];
  log: Logger;
  maxRestarts?: number;
  backoffMs?: number;
  spawn?: SpawnFn;
}

/** Exit code 2 from the helper means bad arguments or a hotkey already taken: restarting cannot help. */
const FATAL_EXIT = 2;

export function superviseHotkeys(opts: SupervisorOptions): { stop(): void } {
  const spawn: SpawnFn =
    opts.spawn ?? ((cmd) => Bun.spawn(cmd, { stdout: "ignore", stderr: "inherit" }));
  const maxRestarts = opts.maxRestarts ?? 3;
  let stopped = false;
  let restarts = 0;
  let current: ReturnType<SpawnFn> | undefined;

  const start = () => {
    current = spawn([opts.binary, ...opts.args]);
    opts.log({ msg: "hotkeys_started" });
    void current.exited.then((code) => {
      if (stopped) return;
      if (code === FATAL_EXIT || restarts >= maxRestarts) {
        opts.log({ level: "error", msg: "hotkeys_gave_up", code });
        return;
      }
      restarts++;
      opts.log({ level: "warn", msg: "hotkeys_restarting", code, attempt: restarts });
      setTimeout(
        () => {
          if (!stopped) start();
        },
        (opts.backoffMs ?? 1000) * restarts,
      );
    });
  };

  start();
  return {
    stop() {
      stopped = true;
      current?.kill();
    },
  };
}
