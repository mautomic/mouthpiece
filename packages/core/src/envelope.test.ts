import { describe, expect, test } from "bun:test";
import type { ModeRequest } from "./contracts.ts";
import {
  MAX_TEXT_CHARS,
  parseInterruptRequest,
  parseModeRequest,
  parsePauseRequest,
  parseReplayRequest,
  parseSpeakEvent,
} from "./envelope.ts";

describe("parseSpeakEvent", () => {
  test("applies defaults to a minimal event", () => {
    expect(parseSpeakEvent({ text: "Hello there", source: "cli" })).toEqual({
      ok: true,
      value: {
        text: "Hello there",
        source: "cli",
        conversationId: "default",
        label: undefined,
        kind: "response",
        priority: "normal",
        mode: undefined,
        format: "markdown",
        voice: undefined,
      },
    });
  });

  test("voice is optional, kept when set, and present as undefined when absent", () => {
    const set = parseSpeakEvent({ text: "x", source: "cli", voice: "Samantha" });
    expect(set.ok && set.value.voice).toBe("Samantha");
    const absent = parseSpeakEvent({ text: "x", source: "cli" });
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect("voice" in absent.value).toBe(true);
      expect(absent.value.voice).toBeUndefined();
    }
  });

  test("alerts default to high priority; explicit priority wins", () => {
    const alert = parseSpeakEvent({ text: "x", source: "cli", kind: "alert" });
    expect(alert.ok && alert.value.priority).toBe("high");
    const low = parseSpeakEvent({ text: "x", source: "cli", kind: "alert", priority: "low" });
    expect(low.ok && low.value.priority).toBe("low");
  });

  test("keeps all optional fields", () => {
    const r = parseSpeakEvent({
      text: "x",
      source: "discord",
      conversationId: "c1",
      label: "alerts",
      kind: "info",
      mode: "full",
      format: "plain",
    });
    expect(r).toMatchObject({
      ok: true,
      value: { conversationId: "c1", label: "alerts", kind: "info", mode: "full", format: "plain" },
    });
  });

  test("ignores unknown fields (forward compatibility)", () => {
    expect(parseSpeakEvent({ text: "x", source: "cli", futureField: 1 }).ok).toBe(true);
  });

  test("preserves emoji and non-ASCII text", () => {
    const r = parseSpeakEvent({ text: "Déploiement réussi 🎉", source: "cli" });
    expect(r.ok && r.value.text).toBe("Déploiement réussi 🎉");
  });

  test.each([
    [null, "body must be a JSON object"],
    [[1], "body must be a JSON object"],
    ["text", "body must be a JSON object"],
    [{ source: "cli" }, "text must be a non-empty string"],
    [{ text: "   ", source: "cli" }, "text must be a non-empty string"],
    [{ text: 5, source: "cli" }, "text must be a non-empty string"],
    [
      { text: "x".repeat(MAX_TEXT_CHARS + 1), source: "cli" },
      `text must be at most ${MAX_TEXT_CHARS} characters`,
    ],
    [{ text: "x" }, "source must match"],
    [{ text: "x", source: "Has Space" }, "source must match"],
    [{ text: "x", source: "cli", kind: "shout" }, "kind must be one of: response, alert, info"],
    [{ text: "x", source: "cli", label: 7 }, "label must be a string"],
    [
      { text: "x", source: "cli", conversationId: "c".repeat(257) },
      "conversationId must be at most 256 characters",
    ],
    [{ text: "x", source: "cli", voice: "v".repeat(101) }, "voice must be at most 100 characters"],
    [{ text: "x", source: "cli", voice: 3 }, "voice must be a string"],
  ])("rejects %p", (input, message) => {
    const r = parseSpeakEvent(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("parseInterruptRequest", () => {
  test("source only means the whole source", () => {
    expect(parseInterruptRequest({ source: "claude-code" })).toEqual({
      ok: true,
      value: { source: "claude-code", conversationId: undefined },
    });
  });
  test("with conversation", () => {
    expect(parseInterruptRequest({ source: "cli", conversationId: "s1" })).toEqual({
      ok: true,
      value: { source: "cli", conversationId: "s1" },
    });
  });
  test("requires source", () => {
    expect(parseInterruptRequest({ conversationId: "s1" }).ok).toBe(false);
  });
});

describe("parseModeRequest", () => {
  test.each<[unknown, ModeRequest]>([
    [
      { mode: "full" },
      {
        mode: "full",
        toggle: undefined,
        clear: undefined,
        source: undefined,
        conversationId: undefined,
      },
    ],
    [
      { toggle: true },
      {
        mode: undefined,
        toggle: true,
        clear: undefined,
        source: undefined,
        conversationId: undefined,
      },
    ],
    [
      { clear: true, source: "claude-code", conversationId: "s1" },
      {
        mode: undefined,
        toggle: undefined,
        clear: true,
        source: "claude-code",
        conversationId: "s1",
      },
    ],
  ])("accepts %p", (input, value) => {
    expect(parseModeRequest(input)).toEqual({ ok: true, value });
  });
  test.each([
    [{}, "exactly one of"],
    [{ mode: "full", toggle: true }, "exactly one of"],
    [{ mode: "loud" }, "mode must be one of"],
    [{ toggle: "yes" }, "toggle must be a boolean"],
    [{ mode: "off", conversationId: "s1" }, "conversationId requires source"],
  ])("rejects %p", (input, message) => {
    const r = parseModeRequest(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("parseReplayRequest", () => {
  test("defaults full to false", () => {
    expect(parseReplayRequest({})).toEqual({ ok: true, value: { full: false } });
  });
  test("rejects non-boolean full", () => {
    expect(parseReplayRequest({ full: 1 }).ok).toBe(false);
  });
});

describe("parsePauseRequest", () => {
  test("accepts a reason matching the pattern", () => {
    for (const reason of ["mic", "user", "a", "do-not-disturb2", `a${"b".repeat(31)}`]) {
      expect(parsePauseRequest({ reason })).toEqual({ ok: true, value: { reason } });
    }
  });
  test("defaults an absent reason to user", () => {
    expect(parsePauseRequest({})).toEqual({ ok: true, value: { reason: "user" } });
    expect(parsePauseRequest({ reason: null })).toEqual({ ok: true, value: { reason: "user" } });
  });
  test("ignores unknown fields", () => {
    expect(parsePauseRequest({ reason: "mic", extra: 1 })).toEqual({
      ok: true,
      value: { reason: "mic" },
    });
  });
  test.each([
    [{ reason: "" }],
    [{ reason: "Mic" }],
    [{ reason: "1mic" }],
    [{ reason: "-mic" }],
    [{ reason: "mic pause" }],
    [{ reason: "mic_pause" }],
    [{ reason: `a${"b".repeat(32)}` }],
    [{ reason: 1 }],
  ])("rejects %p", (input) => {
    const r = parsePauseRequest(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("reason must match");
  });
  test("rejects a non-object body", () => {
    expect(parsePauseRequest("mic").ok).toBe(false);
    expect(parsePauseRequest(null).ok).toBe(false);
  });
});
