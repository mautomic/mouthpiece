#!/usr/bin/env bun
// Spike: dump a Claude Code hook's stdin JSON to $MOUTHPIECE_HOME/spike/<event>-<ms>.json
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.MOUTHPIECE_HOME;
if (!home) process.exit(0); // never write to the real ~/.mouthpiece from the spike
const dir = join(home, "spike");
await mkdir(dir, { recursive: true });
await Bun.write(
  join(dir, `${process.argv[2] ?? "unknown"}-${Date.now()}.json`),
  await Bun.stdin.text(),
);
