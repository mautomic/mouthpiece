import { expect, test } from "bun:test";
import { setTomlValue, unsetTomlKey } from "./config-edit.ts";

test("replaces a key in its table and keeps everything else as written", () => {
  const before = [
    "# my settings",
    "[provider]",
    'chain = ["kokoro", "say"]',
    "",
    "[provider.kokoro]",
    "speed = 1.2",
    'voice = "af_bella"',
    "",
    "[modes]",
    'default = "summary"',
    "",
  ].join("\n");
  expect(setTomlValue(before, "provider.kokoro", "voice", "af_jessica")).toBe(
    before.replace('voice = "af_bella"', 'voice = "af_jessica"'),
  );
  expect(setTomlValue(before, "provider.kokoro", "speed", 1.5)).toBe(
    before.replace("speed = 1.2", "speed = 1.5"),
  );
});

test("keeps a trailing comment and the indentation, even with # inside the old string", () => {
  const before = '[provider.kokoro]\n  voice = "a#b"   # my favourite\n';
  expect(setTomlValue(before, "provider.kokoro", "voice", "af_sky")).toBe(
    '[provider.kokoro]\n  voice = "af_sky"   # my favourite\n',
  );
});

test("adds a missing key at the end of its table, before the blank lines", () => {
  const before = '[provider.kokoro]\nvoice = "af_bella"\n\n[modes]\ndefault = "full"\n';
  expect(setTomlValue(before, "provider.kokoro", "speed", 1.3)).toBe(
    '[provider.kokoro]\nvoice = "af_bella"\nspeed = 1.3\n\n[modes]\ndefault = "full"\n',
  );
});

test("adds a missing table at the end of the file", () => {
  expect(setTomlValue('[provider]\nchain = ["kokoro"]', "provider.kokoro", "speed", 1.3)).toBe(
    '[provider]\nchain = ["kokoro"]\n\n[provider.kokoro]\nspeed = 1.3\n',
  );
  expect(setTomlValue("", "provider.kokoro", "voice", "af_sky")).toBe(
    '[provider.kokoro]\nvoice = "af_sky"\n',
  );
});

test("matches a header with spaces or a comment, and ignores the same key in other tables", () => {
  const before = '[modes]\nvoice = "x"\n[ provider.kokoro ]  # local\nvoice = "y"\n';
  expect(setTomlValue(before, "provider.kokoro", "voice", "z")).toBe(
    '[modes]\nvoice = "x"\n[ provider.kokoro ]  # local\nvoice = "z"\n',
  );
});

test("keeps CRLF line endings", () => {
  expect(
    setTomlValue('[provider.kokoro]\r\nvoice = "a"\r\n', "provider.kokoro", "voice", "b"),
  ).toBe('[provider.kokoro]\r\nvoice = "b"\r\n');
});

test("escapes strings as TOML basic strings", () => {
  expect(setTomlValue("", "t", "k", 'say "hi"\\')).toBe('[t]\nk = "say \\"hi\\"\\\\"\n');
  expect(Bun.TOML.parse(setTomlValue("", "t", "k", 'say "hi"\\'))).toEqual({
    t: { k: 'say "hi"\\' },
  });
});

test("unsetTomlKey removes the key's line and keeps every other line", () => {
  const before = [
    "[sourceVoices.kokoro]",
    'codex = "am_adam"   # the deep one',
    'devin = "af_bella"',
    "",
    "[modes]",
    'default = "full"',
    "",
  ].join("\n");
  expect(unsetTomlKey(before, "sourceVoices.kokoro", "codex")).toBe(
    '[sourceVoices.kokoro]\ndevin = "af_bella"\n\n[modes]\ndefault = "full"\n',
  );
  expect(Bun.TOML.parse(unsetTomlKey(before, "sourceVoices.kokoro", "codex"))).toEqual({
    sourceVoices: { kokoro: { devin: "af_bella" } },
    modes: { default: "full" },
  });
});

test("unsetTomlKey matches a quoted key, and leaves the table header behind", () => {
  const before = '[sourceVoices.kokoro]\n"my.tool" = "am_adam"\n';
  expect(unsetTomlKey(before, "sourceVoices.kokoro", '"my.tool"')).toBe("[sourceVoices.kokoro]\n");
});

test("unsetTomlKey ignores the same key in other tables and missing tables or keys", () => {
  const before = '[voices.kokoro]\ncodex = "x"\n[sourceVoices.kokoro]\ndevin = "y"\n';
  expect(unsetTomlKey(before, "sourceVoices.kokoro", "codex")).toBe(before);
  expect(unsetTomlKey(before, "other.table", "devin")).toBe(before);
  expect(unsetTomlKey("", "sourceVoices.kokoro", "codex")).toBe("");
});
