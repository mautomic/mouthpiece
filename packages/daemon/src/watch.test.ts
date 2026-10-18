import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@mouthpiece/core";
import { watchConfig } from "./watch.ts";
import { writeUntil } from "./write-until.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mp-watch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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
  // Wait for the reload that saw the new content; an earlier fs event may already have
  // reloaded the old file under load.
  await writeUntil(
    path,
    '[modes]\ndefault = "full"\n',
    () => changes.at(-1)?.modes.default === "full",
  );
  expect(changes.at(-1)?.modes.default).toBe("full");
  const applied = changes.length;
  await writeUntil(path, "modes = [", () => errors.length > 0);
  expect(changes.length).toBe(applied); // invalid TOML never reaches onChange
  stop();
  const count = changes.length;
  await writeFile(path, '[modes]\ndefault = "off"\n');
  await Bun.sleep(150);
  expect(changes.length).toBe(count);
}, 20_000);

test("missing directory reports an error and returns a no-op stop", () => {
  const errors: unknown[] = [];
  const stop = watchConfig(join(dir, "nope", "config.toml"), {
    onChange: () => {},
    onError: (e) => void errors.push(e),
  });
  expect(errors).toHaveLength(1);
  stop();
});
