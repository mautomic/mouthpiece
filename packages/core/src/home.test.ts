import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonUrl, mouthpieceHome, readOrCreateToken, readToken, tokenPath } from "./home.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mp-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("mouthpieceHome honors MOUTHPIECE_HOME", () => {
  expect(mouthpieceHome({ MOUTHPIECE_HOME: "/x/y" })).toBe("/x/y");
  expect(mouthpieceHome({})).toEndWith("/.mouthpiece");
});

test("readToken is null when missing", async () => {
  expect(await readToken(home)).toBeNull();
});

test("readOrCreateToken creates a 0600 hex token once", async () => {
  const sub = join(home, "nested");
  const first = await readOrCreateToken(sub);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect((await stat(tokenPath(sub))).mode & 0o777).toBe(0o600);
  expect(await readOrCreateToken(sub)).toBe(first);
  expect(await readToken(sub)).toBe(first);
});

test.each(["", "  \n"])(
  "readOrCreateToken replaces an empty token file (%p) with a fresh 0600 token",
  async (content) => {
    await writeFile(tokenPath(home), content, { mode: 0o644 });
    const token = await readOrCreateToken(home);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(tokenPath(home), "utf8")).trim()).toBe(token);
    expect((await stat(tokenPath(home))).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(["token"]);
  },
);

test("readOrCreateToken waits for a concurrent creator that has not written yet", async () => {
  await writeFile(tokenPath(home), "", { mode: 0o600 });
  setTimeout(() => writeFile(tokenPath(home), "theirs\n"), 0);
  expect(await readOrCreateToken(home)).toBe("theirs");
});

test("daemonUrl precedence: MOUTHPIECE_URL > MOUTHPIECE_PORT > default", () => {
  expect(daemonUrl({ MOUTHPIECE_URL: "http://127.0.0.1:9" })).toBe("http://127.0.0.1:9");
  expect(daemonUrl({ MOUTHPIECE_PORT: "8000" })).toBe("http://127.0.0.1:8000");
  expect(daemonUrl({})).toBe("http://127.0.0.1:7317");
});

test("daemonUrl refuses a non-loopback endpoint", () => {
  expect(() => daemonUrl({ MOUTHPIECE_URL: "https://example.com" })).toThrow("loopback");
});
