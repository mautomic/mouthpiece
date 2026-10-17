import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, resolveConfig } from "@mouthpiece/core";
import { chainProviders, createProviderChain, createProviders, PAID_PROVIDERS } from "./chain.ts";
import { DeepgramProvider } from "./deepgram.ts";
import { ElevenLabsProvider } from "./elevenlabs.ts";
import { FakeProvider } from "./fake.ts";
import { InworldProvider } from "./inworld.ts";
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
