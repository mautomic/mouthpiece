import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, resolveConfig } from "@mouthpiece/core";
import { createProviderChain } from "./chain.ts";

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
