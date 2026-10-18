import { expect, test } from "bun:test";
import type { Exec } from "./exec.ts";
import { deleteSecret, resolveSecret, storeSecret } from "./secrets.ts";

function fakeExec(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: string[][] = [];
  const stdins: (string | undefined)[] = [];
  const exec: Exec = async (cmd, opts) => {
    calls.push(cmd);
    stdins.push(opts?.stdin);
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { exec, calls, stdins };
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
  // The key goes to `security -i` on stdin, never on argv (visible in the process list).
  expect(ok.calls[0]).toEqual(["/usr/bin/security", "-i"]);
  expect(ok.stdins[0]).toBe('add-generic-password -U -s mouthpiece -a "inworld" -w "abc"\n');
  await expect(
    storeSecret("inworld", "abc", fakeExec({ code: 1, stderr: "denied" }).exec),
  ).rejects.toThrow("denied");
  // Interactive mode can exit 0 after a failed command; its error goes to stderr.
  await expect(
    storeSecret("inworld", "abc", fakeExec({ code: 0, stderr: "denied" }).exec),
  ).rejects.toThrow("denied");
  await storeSecret("inworld", "abc", fakeExec({ code: 0, stderr: "security> security> " }).exec);
  expect(await deleteSecret("inworld", ok.exec)).toBe(true);
});

test("storeSecret quotes the value for security -i and rejects multi-line values", async () => {
  const ok = fakeExec({ code: 0 });
  await storeSecret("inworld", 'a"b\\c d', ok.exec);
  expect(ok.stdins[0]).toBe(
    'add-generic-password -U -s mouthpiece -a "inworld" -w "a\\"b\\\\c d"\n',
  );
  await expect(storeSecret("inworld", "a\nb", ok.exec)).rejects.toThrow();
  expect(ok.calls).toHaveLength(1);
});
