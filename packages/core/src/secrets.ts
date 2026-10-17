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

export async function storeSecret(name: string, value: string, exec: Exec): Promise<void> {
  const r = await exec([
    SECURITY,
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    name,
    "-w",
    value,
  ]);
  if (r.code !== 0) throw new Error(`security add-generic-password failed: ${r.stderr.trim()}`);
}

export async function deleteSecret(name: string, exec: Exec): Promise<boolean> {
  const r = await exec([SECURITY, "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
  return r.code === 0;
}
