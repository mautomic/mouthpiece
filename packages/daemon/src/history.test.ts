import { expect, test } from "bun:test";
import { History } from "./history.ts";
import type { SpokenRecord } from "./types.ts";

const rec = (id: string, at: number) =>
  ({ id, at, full: id, summary: undefined, spoken: id, event: {} }) as unknown as SpokenRecord;

test("keeps the last maxItems and drops items older than maxAgeMs", () => {
  let t = 0;
  const h = new History({ maxItems: 2, maxAgeMs: 100 }, () => t);
  h.add(rec("a", 0));
  h.add(rec("b", 0));
  h.add(rec("c", 0));
  expect(h.size).toBe(2);
  expect(h.last()?.id).toBe("c");
  t = 101;
  expect(h.last()).toBeUndefined();
});
