import { expect, test } from "bun:test";
import * as core from "@mouthpiece/core";

test("workspace packages resolve", () => {
  expect(core).toBeDefined();
});
