import { isKokoroSpeed, KOKORO_SPEED_MAX, KOKORO_SPEED_MIN } from "./config.ts";
import {
  FORMATS,
  type InterruptRequest,
  KINDS,
  MODES,
  type ModeRequest,
  type NormalizedSpeakEvent,
  type PauseRequest,
  PRIORITIES,
  type ReplayRequest,
  type SettingsUpdate,
} from "./contracts.ts";
import { isRecord } from "./guards.ts";

export const MAX_TEXT_CHARS = 100_000;
export const MAX_CONVERSATION_ID_CHARS = 256;
export const MAX_LABEL_CHARS = 100;
export const MAX_VOICE_CHARS = 100;
export const DEFAULT_CONVERSATION_ID = "default";
export const DEFAULT_PAUSE_REASON = "user";
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PAUSE_REASON_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

class ParseError extends Error {}

function fail(message: string): never {
  throw new ParseError(message);
}

function parse<T>(build: () => T): ParseResult<T> {
  try {
    return { ok: true, value: build() };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message };
    throw error;
  }
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail(`${key} must be a string`);
  if (value.length > max) fail(`${key} must be at most ${max} characters`);
  return value;
}

function optionalEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail(`${key} must be a boolean`);
  return value;
}

function requiredSource(obj: Record<string, unknown>): string {
  const value = obj.source;
  if (typeof value !== "string" || !SOURCE_PATTERN.test(value)) {
    fail(`source must match ${SOURCE_PATTERN.source}`);
  }
  return value;
}

export function parseSpeakEvent(input: unknown): ParseResult<NormalizedSpeakEvent> {
  return parse(() => {
    if (!isRecord(input)) fail("body must be a JSON object");
    const text = input.text;
    if (typeof text !== "string" || text.trim() === "") fail("text must be a non-empty string");
    if (text.length > MAX_TEXT_CHARS) fail(`text must be at most ${MAX_TEXT_CHARS} characters`);
    const kind = optionalEnum(input, "kind", KINDS) ?? "response";
    return {
      text,
      source: requiredSource(input),
      conversationId:
        optionalString(input, "conversationId", MAX_CONVERSATION_ID_CHARS) ??
        DEFAULT_CONVERSATION_ID,
      label: optionalString(input, "label", MAX_LABEL_CHARS),
      kind,
      priority:
        optionalEnum(input, "priority", PRIORITIES) ?? (kind === "alert" ? "high" : "normal"),
      mode: optionalEnum(input, "mode", MODES),
      format: optionalEnum(input, "format", FORMATS) ?? "markdown",
      voice: optionalString(input, "voice", MAX_VOICE_CHARS),
    };
  });
}

export function parseInterruptRequest(input: unknown): ParseResult<InterruptRequest> {
  return parse(() => {
    if (!isRecord(input)) fail("body must be a JSON object");
    return {
      source: requiredSource(input),
      conversationId: optionalString(input, "conversationId", MAX_CONVERSATION_ID_CHARS),
    };
  });
}

export function parseModeRequest(input: unknown): ParseResult<ModeRequest> {
  return parse(() => {
    if (!isRecord(input)) fail("body must be a JSON object");
    const mode = optionalEnum(input, "mode", MODES);
    const toggle = optionalBoolean(input, "toggle") === true ? true : undefined;
    const clear = optionalBoolean(input, "clear") === true ? true : undefined;
    if ([mode !== undefined, toggle, clear].filter(Boolean).length !== 1) {
      fail("exactly one of mode, toggle: true, or clear: true is required");
    }
    const source = input.source === undefined ? undefined : requiredSource(input);
    const conversationId = optionalString(input, "conversationId", MAX_CONVERSATION_ID_CHARS);
    if (conversationId !== undefined && source === undefined)
      fail("conversationId requires source");
    return { mode, toggle, clear, source, conversationId };
  });
}

export function parseReplayRequest(input: unknown): ParseResult<ReplayRequest> {
  return parse(() => {
    if (!isRecord(input)) fail("body must be a JSON object");
    return { full: optionalBoolean(input, "full") ?? false };
  });
}

/** POST /v1/settings. Whether a voice exists is up to the daemon, which knows the providers. */
export function parseSettingsUpdate(input: unknown): ParseResult<SettingsUpdate> {
  return parse(() => {
    if (!isRecord(input)) fail("body must be a JSON object");
    const kokoro = input.kokoro;
    if (!isRecord(kokoro)) fail("kokoro must be an object");
    const voice = optionalString(kokoro, "voice", MAX_VOICE_CHARS);
    const speed = kokoro.speed;
    if (speed !== undefined && !isKokoroSpeed(speed)) {
      fail(`kokoro.speed must be a number from ${KOKORO_SPEED_MIN} to ${KOKORO_SPEED_MAX}`);
    }
    if (voice === undefined && speed === undefined) fail("kokoro needs voice or speed");
    return {
      kokoro: { ...(voice !== undefined && { voice }), ...(speed !== undefined && { speed }) },
    };
  });
}

/** POST /v1/pause and /v1/resume. An absent reason means `user`. */
export function parsePauseRequest(input: unknown): ParseResult<PauseRequest> {
  return parse(() => {
    if (!isRecord(input)) fail("body must be a JSON object");
    const reason = input.reason ?? DEFAULT_PAUSE_REASON;
    if (typeof reason !== "string" || !PAUSE_REASON_PATTERN.test(reason)) {
      fail(`reason must match ${PAUSE_REASON_PATTERN.source}`);
    }
    return { reason };
  });
}
