import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, resolveConfig } from "@mouthpiece/core";
import { createSummarizer } from "./factory.ts";

test("claude-cli by default, none disables", () => {
  expect(createSummarizer(DEFAULT_CONFIG, { home: "/h", env: {} })?.name).toBe("claude-cli");
  expect(
    createSummarizer(resolveConfig({ summarizer: { backend: "none" } }), { home: "/h", env: {} }),
  ).toBeUndefined();
});
