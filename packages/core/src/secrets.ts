import type { Exec } from "./exec.ts";
import type { Env } from "./home.ts";

export const KEYCHAIN_SERVICE = "mouthpiece";
const SECURITY = "/usr/bin/security";

/** `<NAME>_API_KEY` env var first, then the login Keychain (service "mouthpiece", account <name>). */
export async function resolveSecret(
  name: string,
  deps: { env: Env; exec: Exec },
): Promise<string | undefined> {
  const fromEnv = deps.env[`${name.toUpperCase().replace(/-/g, "_")}_API_KEY`];
  if (fromEnv) return fromEnv;
  const r = await deps.exec([
    SECURITY,
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    name,
    "-w",
  ]);
  const value = r.stdout.trim();
  return r.code === 0 && value ? value : undefined;
}

/** Double-quotes a token for `security -i`, which splits its input lines like a shell. */
const quoted = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

/** Sends the command to `security -i` on stdin so the secret never appears in argv (the process list). */
export async function storeSecret(name: string, value: string, exec: Exec): Promise<void> {
  if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
    throw new Error("secret name and value must be a single line");
  }
  const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${quoted(name)} -w ${quoted(value)}`;
  const r = await exec([SECURITY, "-i"], { stdin: `${command}\n` });
  // Interactive mode may exit 0 after a failed command, so stderr output other than the
  // "security> " prompt also counts as failure.
  const error = r.stderr.replaceAll("security> ", "").trim();
  if (r.code !== 0 || error) throw new Error(`security add-generic-password failed: ${error}`);
}

export async function deleteSecret(name: string, exec: Exec): Promise<boolean> {
  const r = await exec([SECURITY, "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
  return r.code === 0;
}
