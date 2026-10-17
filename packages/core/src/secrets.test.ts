import { expect, test } from "bun:test";
import type { Exec } from "./exec.ts";
import { deleteSecret, resolveSecret, storeSecret } from "./secrets.ts";

function fakeExec(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { exec, calls };
}

test("env var wins and skips the keychain", async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: "kc\n" });
  expect(await resolveSecret("inworld", { env: { INWORLD_API_KEY: "env" }, exec })).toBe("env");
  expect(calls).toEqual([]);
});

test("falls back to the keychain; missing item is undefined", async () => {
  const hit = fakeExec({ code: 0, stdout: "kc-key\n" });
  expect(await resolveSecret("inworld", { env: {}, exec: hit.exec })).toBe("kc-key");
  expect(hit.calls[0]).toEqual([
    "/usr/bin/security",
    "find-generic-password",
    "-s",
    "mouthpiece",
    "-a",
    "inworld",
    "-w",
  ]);
  expect(
    await resolveSecret("inworld", { env: {}, exec: fakeExec({ code: 44 }).exec }),
  ).toBeUndefined();
});

test("store and delete", async () => {
  const ok = fakeExec({ code: 0 });
  await storeSecret("inworld", "abc", ok.exec);
  expect(ok.calls[0]).toEqual([
    "/usr/bin/security",
    "add-generic-password",
    "-U",
    "-s",
    "mouthpiece",
    "-a",
    "inworld",
    "-w",
    "abc",
  ]);
  await expect(
    storeSecret("inworld", "abc", fakeExec({ code: 1, stderr: "denied" }).exec),
  ).rejects.toThrow("denied");
  expect(await deleteSecret("inworld", ok.exec)).toBe(true);
});
