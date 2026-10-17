import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@mouthpiece/core";
import { watchConfig } from "./watch.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-watch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms = 3000) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

test("reloads on change and reports invalid TOML without calling onChange", async () => {
  const path = join(dir, "config.toml");
  await writeFile(path, '[modes]\ndefault = "summary"\n');
  const changes: Config[] = [];
  const errors: unknown[] = [];
  const stop = watchConfig(path, {
    onChange: (c) => void changes.push(c),
    onError: (e) => void errors.push(e),
    debounceMs: 20,
  });
  await writeFile(path, '[modes]\ndefault = "full"\n');
  // Wait for the reload that saw the new content; an earlier fs event may already have
  // reloaded the old file under load.
  await waitFor(() => changes.at(-1)?.modes.default === "full");
  expect(changes.at(-1)?.modes.default).toBe("full");
  await writeFile(path, "modes = [");
  await waitFor(() => errors.length > 0);
  stop();
  const count = changes.length;
  await writeFile(path, '[modes]\ndefault = "off"\n');
  await Bun.sleep(150);
  expect(changes.length).toBe(count);
});

test("missing directory reports an error and returns a no-op stop", () => {
  const errors: unknown[] = [];
  const stop = watchConfig(join(dir, "nope", "config.toml"), {
    onChange: () => {},
    onError: (e) => void errors.push(e),
  });
  expect(errors).toHaveLength(1);
  stop();
});
