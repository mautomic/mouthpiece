import { resolve } from "node:path";
import * as client from "@mouthpiece/client";
import { defaultExec } from "@mouthpiece/core";
import { startDaemon } from "@mouthpiece/daemon";
import { run } from "./run.ts";

const argv = process.argv.slice(2);
const code = await run(
  argv,
  {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    readStdin: () => Bun.stdin.text(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
  },
  {
    client,
    startDaemon,
    env: process.env,
    exec: defaultExec,
    paths: { repoRoot: resolve(import.meta.dir, "../../.."), bun: process.execPath },
  },
);
// `start` keeps the server alive; every other command exits.
if (argv[0] !== "start" || code !== 0) process.exit(code);
