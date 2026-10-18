import { expect, test } from "bun:test";
import { ORCA_BIN } from "@mouthpiece/adapter-orca";
import { type Exec, resolveConfig } from "@mouthpiece/core";
import { replyDrivers } from "./reply-drivers.ts";

test("the Orca driver uses [reply] orca, else Orca's bundled CLI", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    return { code: 1, stdout: "", stderr: "" };
  };
  const route = { via: "orca", target: "term_abc", agent: "claude" } as const;
  const [custom] = replyDrivers(resolveConfig({ reply: { orca: "/opt/orca" } }), exec);
  expect(custom?.via).toBe("orca");
  await custom?.check(route);
  const [fallback] = replyDrivers(resolveConfig({}), exec);
  await fallback?.check(route);
  expect(calls.map((c) => c[0])).toEqual(["/opt/orca", ORCA_BIN]);
});
