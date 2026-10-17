import { expect, test } from "bun:test";
import type { VoicesResponse } from "@mouthpiece/core";
import { VOICES_TIMEOUT_MS } from "@mouthpiece/daemon";
import { run } from "../run.ts";
import type { CliDeps, CliIO } from "../types.ts";

const RESPONSE: VoicesResponse = {
  providers: [
    {
      provider: "say",
      voices: [
        { id: "Samantha", name: "Samantha", language: "en_US" },
        { id: "Thomas", name: "Thomas", language: "fr_FR" },
      ],
    },
    { provider: "openai", voices: [{ id: "alloy", name: "Alloy" }] },
    { provider: "inworld", voices: [], error: "HTTP 401" },
    { provider: "deepgram", voices: [] },
  ],
};

function harness(response: VoicesResponse = RESPONSE) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { provider?: string }[] = [];
  const timeouts: (number | undefined)[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => "",
    stdinIsTTY: true,
  };
  const deps: CliDeps = {
    client: {
      speak: async () => ({ id: "abc" }),
      stop: async () => ({ stopped: true, dropped: 0 }),
      skip: async () => ({ skipped: true }),
      health: async () => ({ ok: true, version: "0.1.0", provider: "say", queueDepth: 0 }),
      getMode: async () => ({ default: "summary", overrides: [] }),
      setMode: async () => ({ default: "summary", overrides: [] }),
      replay: async () => ({ id: null }),
      usage: async () => ({ from: "a", to: "b", rows: [], quotas: [] }),
      voices: async (opts) => {
        calls.push({ provider: opts?.provider });
        timeouts.push(opts?.timeoutMs);
        return response;
      },
    },
    startDaemon: async () => ({ url: "http://127.0.0.1:7317" }),
    env: {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    paths: { repoRoot: "/repo", bun: "/bun" },
  };
  return { io, deps, out, err, calls, timeouts };
}

test("voices prints each provider and its voices, including errors", async () => {
  const h = harness();
  expect(await run(["voices"], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual([{ provider: undefined }]);
  expect(h.out.join("")).toBe(
    [
      "provider: say",
      "  Samantha  Samantha  en_US",
      "  Thomas  Thomas  fr_FR",
      "provider: openai",
      "  alloy  Alloy",
      "provider: inworld",
      "  (error: HTTP 401)",
      "provider: deepgram",
      "  (no voices)",
      "",
    ].join("\n"),
  );
});

test("voices --provider passes the provider to the client", async () => {
  const h = harness({ providers: [{ provider: "say", voices: [] }] });
  expect(await run(["voices", "--provider", "say"], h.io, h.deps)).toBe(0);
  expect(h.calls).toEqual([{ provider: "say" }]);
});

test("voices waits longer than the daemon's per-provider voice-list limit", async () => {
  const h = harness();
  expect(await run(["voices"], h.io, h.deps)).toBe(0);
  const [timeoutMs] = h.timeouts;
  expect(timeoutMs).toBeGreaterThanOrEqual(8000);
  expect(timeoutMs).toBeGreaterThan(VOICES_TIMEOUT_MS);
});
