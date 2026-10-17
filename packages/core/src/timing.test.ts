import { expect, test } from "bun:test";
import { delay } from "./timing.ts";

test("delay resolves", async () => {
  await delay(1);
});

test("delay rejects when aborted", async () => {
  const c = new AbortController();
  const p = delay(10_000, c.signal);
  c.abort();
  await expect(p).rejects.toBeDefined();
});

test("delay rejects immediately for an already-aborted signal", async () => {
  await expect(delay(10_000, AbortSignal.abort())).rejects.toBeDefined();
});
