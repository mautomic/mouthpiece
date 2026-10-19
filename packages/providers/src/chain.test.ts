import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, resolveConfig, type TtsProvider } from "@mouthpiece/core";
import { chainProviders, createProviderChain, createProviders, PAID_PROVIDERS } from "./chain.ts";
import { DeepgramProvider } from "./deepgram.ts";
import { ElevenLabsProvider } from "./elevenlabs.ts";
import { FakeProvider } from "./fake.ts";
import { ProviderHttpError } from "./http.ts";
import { InworldProvider } from "./inworld.ts";
import {
  KOKORO_MS_PER_CHAR,
  type KokoroEngine,
  KokoroProvider,
  kokoroTimeoutMs,
} from "./kokoro.ts";
import { OpenAIProvider } from "./openai.ts";
import { SayProvider } from "./say.ts";

const deps = (env: Record<string, string | undefined> = {}) => {
  const logs: Record<string, unknown>[] = [];
  return {
    deps: { env, tmpDir: "/tmp/mp-chain-test", log: (r: Record<string, unknown>) => logs.push(r) },
    logs,
  };
};

test("default chain is say only", () => {
  expect(createProviderChain(DEFAULT_CONFIG, deps().deps).name).toBe("say");
});

test("inworld is used when the key is present", () => {
  const config = resolveConfig({ provider: { chain: ["inworld", "say"] } });
  expect(createProviderChain(config, deps({ INWORLD_API_KEY: "k" }).deps).name).toBe("inworld>say");
});

test("inworld without a key is skipped with a warning", () => {
  const config = resolveConfig({ provider: { chain: ["inworld", "say"] } });
  const { deps: d, logs } = deps();
  expect(createProviderChain(config, d).name).toBe("say");
  expect(logs[0]).toMatchObject({ level: "warn", msg: "provider_skipped", provider: "inworld" });
});

test("a chain with nothing usable falls back to say", () => {
  const config = resolveConfig({ provider: { chain: ["inworld"] } });
  expect(createProviderChain(config, deps().deps).name).toBe("say");
});

test("unknown provider names are a config error", () => {
  const config = resolveConfig({ provider: { chain: ["nope"] } });
  expect(() => createProviderChain(config, deps().deps)).toThrow("unknown provider: nope");
});

test("say is appended when the chain doesn't end in it", () => {
  const config = resolveConfig({ provider: { chain: ["inworld"] } });
  expect(createProviderChain(config, deps({ INWORLD_API_KEY: "k" }).deps).name).toBe("inworld>say");
});

test("keychain secret is used when the env var is absent", () => {
  const config = resolveConfig({ provider: { chain: ["inworld", "say"] } });
  expect(createProviderChain(config, { ...deps().deps, secrets: { inworld: "kc" } }).name).toBe(
    "inworld>say",
  );
});

test("wrap is applied to every provider", () => {
  const wrapped: string[] = [];
  const config = resolveConfig({ provider: { chain: ["inworld", "say"] } });
  createProviderChain(config, {
    ...deps({ INWORLD_API_KEY: "k" }).deps,
    wrap: (p) => {
      wrapped.push(p.name);
      return p;
    },
  });
  expect(wrapped).toEqual(["inworld", "say"]);
});

const ALL = ["inworld", "elevenlabs", "deepgram", "openai", "say"];
const allKeys = {
  INWORLD_API_KEY: "k1",
  ELEVENLABS_API_KEY: "k2",
  DEEPGRAM_API_KEY: "k3",
  OPENAI_API_KEY: "k4",
};

test("PAID_PROVIDERS lists every keyed provider", () => {
  expect([...PAID_PROVIDERS]).toEqual(["inworld", "elevenlabs", "deepgram", "openai"]);
});

test("createProviders builds all five providers in order when keys are in env", () => {
  const config = resolveConfig({ provider: { chain: ALL } });
  const providers = createProviders(config, deps(allKeys).deps);
  expect(providers.map((p) => p.name)).toEqual(ALL);
  expect(providers[0]).toBeInstanceOf(InworldProvider);
  expect(providers[1]).toBeInstanceOf(ElevenLabsProvider);
  expect(providers[2]).toBeInstanceOf(DeepgramProvider);
  expect(providers[3]).toBeInstanceOf(OpenAIProvider);
  expect(providers[4]).toBeInstanceOf(SayProvider);
  expect(createProviderChain(config, deps(allKeys).deps).name).toBe(ALL.join(">"));
});

test("createProviders passes each provider's configured model and voice", () => {
  const config = resolveConfig({
    provider: {
      chain: ["elevenlabs", "deepgram", "openai"],
      elevenlabs: { model: "eleven_multilingual_v2", voice: "EV" },
      deepgram: { model: "aura-2-apollo-en" },
      openai: { model: "tts-1-hd", voice: "nova" },
    },
  });
  const [el, dg, oa] = createProviders(config, deps(allKeys).deps);
  expect(el?.cacheKey).toBe("EV\u0000eleven_multilingual_v2");
  expect(dg?.cacheKey).toBe("aura-2-apollo-en\u0000aura-2-apollo-en");
  expect(oa?.cacheKey).toBe("nova\u0000tts-1-hd");
  expect(oa?.pricePerMillionChars).toBe(30);
});

test("a paid provider without a key is skipped with a warning", () => {
  const config = resolveConfig({ provider: { chain: ["elevenlabs", "openai", "say"] } });
  const { deps: d, logs } = deps({ OPENAI_API_KEY: "k" });
  expect(createProviders(config, d).map((p) => p.name)).toEqual(["openai", "say"]);
  expect(logs).toEqual([
    expect.objectContaining({ level: "warn", msg: "provider_skipped", provider: "elevenlabs" }),
  ]);
});

test("secrets provide keys", () => {
  const config = resolveConfig({ provider: { chain: ["deepgram", "openai"] } });
  const providers = createProviders(config, {
    ...deps().deps,
    secrets: { deepgram: "kc", openai: "kc" },
  });
  expect(providers.map((p) => p.name)).toEqual(["deepgram", "openai", "say"]);
});

test("createProviders throws on an unknown name and appends say", () => {
  expect(() =>
    createProviders(resolveConfig({ provider: { chain: ["nope"] } }), deps().deps),
  ).toThrow("unknown provider: nope");
  const config = resolveConfig({ provider: { chain: ["openai"] } });
  expect(createProviders(config, deps(allKeys).deps).map((p) => p.name)).toEqual(["openai", "say"]);
});

test("the voices config maps the event label to a voice per provider", async () => {
  const fake = new FakeProvider({ name: "say" });
  const config = resolveConfig({ provider: { chain: ["say"] }, voices: { say: { web: "Ava" } } });
  const chain = createProviderChain(config, { ...deps().deps, wrap: () => fake });
  await chain.synthesize("x", { label: "web" });
  await chain.synthesize("x", { label: "other" });
  await chain.synthesize("x", { label: "web", voice: "Explicit" });
  expect(fake.options.map((o) => o.voice)).toEqual(["Ava", undefined, "Explicit"]);
});

test("the voice map sits outside wrap, so wrapped providers see the mapped voice", async () => {
  const seen: (string | undefined)[] = [];
  const config = resolveConfig({ provider: { chain: ["say"] }, voices: { say: { web: "Ava" } } });
  const chain = createProviderChain(config, {
    ...deps().deps,
    wrap: (p) => {
      const fake = new FakeProvider({ name: p.name });
      return {
        name: fake.name,
        maxCharsPerRequest: fake.maxCharsPerRequest,
        pricePerMillionChars: 0,
        synthesize: (text, opts) => {
          seen.push(opts?.voice);
          return fake.synthesize(text, opts);
        },
      };
    },
  });
  await chain.synthesize("x", { label: "web" });
  expect(seen).toEqual(["Ava"]);
});

test("chainProviders maps voices and falls back across a given provider list", async () => {
  const broken = new FakeProvider({ name: "inworld", failWith: new Error("down") });
  const say = new FakeProvider({ name: "say" });
  const config = resolveConfig({ voices: { say: { web: "Ava" } } });
  const { deps: d, logs } = deps();
  const chain = chainProviders([broken, say], config, d);
  expect(chain.name).toBe("inworld>say");
  await chain.synthesize("x", { label: "web" });
  expect(say.options[0]?.voice).toBe("Ava");
  expect(logs).toEqual([
    expect.objectContaining({ level: "warn", msg: "provider_fallback", provider: "inworld" }),
  ]);
});

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "mp-chain-kokoro-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("kokoro is not paid (no key)", () => {
  expect((PAID_PROVIDERS as readonly string[]).includes("kokoro")).toBe(false);
});

test("kokoro is skipped with an install hint when it isn't installed", async () => {
  await withHome(async (home) => {
    const config = resolveConfig({ provider: { chain: ["kokoro", "say"] } });
    const { deps: d, logs } = deps();
    expect(createProviders(config, { ...d, home }).map((p) => p.name)).toEqual(["say"]);
    expect(logs).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "provider_skipped",
        provider: "kokoro",
        reason: "not installed; run mouthpiece kokoro install",
      }),
    ]);
  });
});

test("kokoro is skipped when no home is given", () => {
  const config = resolveConfig({ provider: { chain: ["kokoro"] } });
  const { deps: d, logs } = deps();
  expect(createProviders(config, d).map((p) => p.name)).toEqual(["say"]);
  expect(logs[0]).toMatchObject({ msg: "provider_skipped", provider: "kokoro" });
});

test("kokoro is built with the configured voice and the injected loader when installed", async () => {
  await withHome(async (home) => {
    const pkg = join(home, "kokoro", "node_modules", "kokoro-js");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), "{}");
    const voices: string[] = [];
    const engine: KokoroEngine = {
      async generate(_text, { voice }) {
        voices.push(voice);
        return { toWav: () => new Uint8Array([1, 2, 3]).buffer };
      },
    };
    const config = resolveConfig({
      provider: { chain: ["kokoro", "say"], kokoro: { voice: "bm_george" } },
    });
    const { deps: d, logs } = deps();
    const providers = createProviders(config, { ...d, home, kokoroLoader: async () => engine });
    expect(providers.map((p) => p.name)).toEqual(["kokoro", "say"]);
    expect(providers[0]).toBeInstanceOf(KokoroProvider);
    expect(providers[0]?.cacheKey).toBe("bm_george\0q8\x001.3"); // the default speed, 1.3
    const clip = await createProviderChain(config, {
      ...d,
      home,
      kokoroLoader: async () => engine,
    }).synthesize("Hi.");
    expect(clip.format).toBe("wav");
    expect(voices).toEqual(["bm_george"]);
    expect(logs).toEqual([]);
  });
});

test("kokoro renders a whole chunk before any audio, so its timeout scales with the text", async () => {
  await withHome(async (home) => {
    const pkg = join(home, "kokoro", "node_modules", "kokoro-js");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), "{}");
    const engine: KokoroEngine = {
      async generate(text) {
        await Bun.sleep(150); // longer than the first-byte timeout below
        return { toWav: () => new TextEncoder().encode(text).buffer as ArrayBuffer };
      },
    };
    const config = resolveConfig({
      provider: { chain: ["kokoro", "say"] },
      fallback: { firstByteTimeoutMs: 50 },
    });
    const { deps: d, logs } = deps();
    const clip = await createProviderChain(config, {
      ...d,
      home,
      kokoroLoader: async () => engine,
    }).synthesize("A sentence of a realistic length for one chunk.");
    expect(clip.format).toBe("wav");
    expect(logs).toEqual([]);
  });
  expect(kokoroTimeoutMs("x".repeat(400), 3000)).toBe(3000 + 400 * KOKORO_MS_PER_CHAR);
});

test("provider_fallback is logged once per provider per minute, with the suppressed count", async () => {
  const broken = new FakeProvider({ name: "kokoro", failWith: new Error("bad voice") });
  const alsoBroken = new FakeProvider({ name: "inworld", failWith: new Error("down") });
  const say = new FakeProvider({ name: "say" });
  const clock = { t: 0 };
  const { deps: d, logs } = deps();
  const chain = chainProviders([broken, alsoBroken, say], resolveConfig({}), {
    ...d,
    now: () => clock.t,
  });
  for (const t of [0, 10_000, 59_999]) {
    clock.t = t;
    await chain.synthesize("x");
  }
  // Every chunk still fell back (unchanged), but each provider was logged once.
  expect(say.calls).toEqual(["x", "x", "x"]);
  expect(logs).toEqual([
    { level: "warn", msg: "provider_fallback", provider: "kokoro", error: "Error: bad voice" },
    { level: "warn", msg: "provider_fallback", provider: "inworld", error: "Error: down" },
  ]);

  clock.t = 60_000;
  await chain.synthesize("x");
  expect(logs.slice(2)).toEqual([
    {
      level: "warn",
      msg: "provider_fallback",
      provider: "kokoro",
      error: "Error: bad voice",
      suppressed: 2,
    },
    {
      level: "warn",
      msg: "provider_fallback",
      provider: "inworld",
      error: "Error: down",
      suppressed: 2,
    },
  ]);
});

test("provider_fallback is rate-limited per provider and kind of error, not per provider", async () => {
  const errors = [
    new Error("kokoro: no audio within 3150ms"),
    new Error("kokoro host exited (code 134)"), // a different failure: logged at once
    new Error("kokoro: no audio within 4200ms"), // the first one again, with other numbers
    new Error("request 7f3a9c2e1b4d failed"),
    new Error("request 0c1d2e3f4a5b failed"), // same message, different id
  ];
  let next = 0;
  const flaky: TtsProvider = {
    name: "kokoro",
    maxCharsPerRequest: 400,
    pricePerMillionChars: 0,
    async synthesize() {
      throw errors[next++];
    },
  };
  const say = new FakeProvider({ name: "say" });
  const clock = { t: 0 };
  const { deps: d, logs } = deps();
  const chain = chainProviders([flaky, say], resolveConfig({}), { ...d, now: () => clock.t });
  for (const _ of errors) {
    clock.t += 1_000;
    await chain.synthesize("x");
  }
  expect(logs.map((l) => l.error)).toEqual([
    "Error: kokoro: no audio within 3150ms",
    "Error: kokoro host exited (code 134)",
    "Error: request 7f3a9c2e1b4d failed",
  ]);

  clock.t += 60_000;
  next = 0;
  await chain.synthesize("x");
  expect(logs.at(-1)).toEqual({
    level: "warn",
    msg: "provider_fallback",
    provider: "kokoro",
    error: "Error: kokoro: no audio within 3150ms",
    suppressed: 1,
  });
});

test("provider_fallback treats HTTP errors with different statuses as different kinds", async () => {
  const errors = [
    new ProviderHttpError("inworld", 401, "no body"),
    new ProviderHttpError("inworld", 429, "no body"), // same body, other status: logged at once
    new ProviderHttpError("inworld", 429, "no body"), // repeat: suppressed
  ];
  let next = 0;
  const flaky: TtsProvider = {
    name: "inworld",
    maxCharsPerRequest: 2000,
    pricePerMillionChars: 5,
    async synthesize() {
      throw errors[next++];
    },
  };
  const say = new FakeProvider({ name: "say" });
  const clock = { t: 0 };
  const { deps: d, logs } = deps();
  const chain = chainProviders([flaky, say], resolveConfig({}), { ...d, now: () => clock.t });
  for (const _ of errors) {
    clock.t += 1_000;
    await chain.synthesize("x");
  }
  expect(logs.map((l) => l.error)).toEqual([
    "ProviderHttpError: inworld HTTP 401: no body",
    "ProviderHttpError: inworld HTTP 429: no body",
  ]);
});
