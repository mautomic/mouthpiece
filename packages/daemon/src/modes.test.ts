import { expect, test } from "bun:test";
import type { NormalizedSpeakEvent } from "@mouthpiece/core";
import { ModeStore } from "./modes.ts";

const ev = (source: string, conversationId = "c1", mode?: "summary" | "full" | "off") =>
  ({
    text: "x",
    source,
    conversationId,
    label: undefined,
    kind: "response",
    priority: "normal",
    mode,
    format: "plain",
  }) as NormalizedSpeakEvent;

test("precedence: event > conversation > source > global runtime > profile > config default", () => {
  const m = new ModeStore("summary", { cron: { mode: "full" } });
  expect(m.resolve(ev("claude-code"))).toBe("summary");
  expect(m.resolve(ev("cron"))).toBe("full");
  m.apply({ mode: "off" });
  expect(m.resolve(ev("cron"))).toBe("off");
  m.apply({ mode: "full", source: "claude-code" });
  expect(m.resolve(ev("claude-code"))).toBe("full");
  m.apply({ mode: "summary", source: "claude-code", conversationId: "c2" });
  expect(m.resolve(ev("claude-code", "c2"))).toBe("summary");
  expect(m.resolve(ev("claude-code", "c2", "off"))).toBe("off");
});

test("toggle flips the effective mode at its scope; off toggles to summary", () => {
  const m = new ModeStore("summary", {});
  expect(m.apply({ toggle: true }).default).toBe("full");
  expect(m.apply({ toggle: true }).default).toBe("summary");
  m.apply({ mode: "off" });
  expect(m.apply({ toggle: true }).default).toBe("summary");
});

test("clear removes the override; state lists scoped overrides", () => {
  const m = new ModeStore("summary", {});
  m.apply({ mode: "full", source: "claude-code", conversationId: "s1" });
  expect(m.state()).toEqual({
    default: "summary",
    overrides: [{ source: "claude-code", conversationId: "s1", mode: "full" }],
  });
  m.apply({ clear: true, source: "claude-code", conversationId: "s1" });
  expect(m.state().overrides).toEqual([]);
});

test("configure updates config default and profiles but keeps runtime overrides", () => {
  const m = new ModeStore("summary", {});
  m.apply({ mode: "full", source: "x" });
  m.configure("off", {});
  expect(m.resolve(ev("y"))).toBe("off");
  expect(m.resolve(ev("x"))).toBe("full");
});
