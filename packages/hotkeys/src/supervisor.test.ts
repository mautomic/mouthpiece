import { expect, test } from "bun:test";
import { type SpawnFn, superviseHotkeys } from "./supervisor.ts";

function fakeSpawn(exitCodes: number[]) {
  const started: string[][] = [];
  let killed = 0;
  const spawn: SpawnFn = (cmd) => {
    started.push(cmd);
    const code = exitCodes.shift();
    return {
      exited: code === undefined ? new Promise(() => {}) : Promise.resolve(code),
      kill: () => void killed++,
    };
  };
  return { spawn, started, killed: () => killed };
}

test("restarts after crashes, then gives up after maxRestarts", async () => {
  const f = fakeSpawn([1, 1, 1, 1]);
  const logs: Record<string, unknown>[] = [];
  superviseHotkeys({
    binary: "/b",
    args: ["--x"],
    log: (r) => logs.push(r),
    maxRestarts: 3,
    backoffMs: 1,
    spawn: f.spawn,
  });
  await Bun.sleep(50);
  expect(f.started).toHaveLength(4);
  expect(f.started[0]).toEqual(["/b", "--x"]);
  expect(logs.at(-1)).toMatchObject({ level: "error", msg: "hotkeys_gave_up" });
});

test("exit 2 is fatal (bad args or hotkey taken)", async () => {
  const f = fakeSpawn([2]);
  const logs: Record<string, unknown>[] = [];
  superviseHotkeys({
    binary: "/b",
    args: [],
    log: (r) => logs.push(r),
    backoffMs: 1,
    spawn: f.spawn,
  });
  await Bun.sleep(20);
  expect(f.started).toHaveLength(1);
  expect(logs.at(-1)).toMatchObject({ level: "error", msg: "hotkeys_gave_up", code: 2 });
});

test("stop kills the helper and prevents restarts", async () => {
  const f = fakeSpawn([]);
  const s = superviseHotkeys({
    binary: "/b",
    args: [],
    log: () => {},
    backoffMs: 1,
    spawn: f.spawn,
  });
  s.stop();
  expect(f.killed()).toBe(1);
});
