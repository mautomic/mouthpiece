import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { delay } from "./timing.ts";

export type Env = Record<string, string | undefined>;
export const DEFAULT_PORT = 7317;

export function mouthpieceHome(env: Env = process.env): string {
  return env.MOUTHPIECE_HOME || join(homedir(), ".mouthpiece");
}

export function tokenPath(home: string): string {
  return join(home, "token");
}

export async function readToken(home: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath(home), "utf8")).trim();
    return token || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const TOKEN_RACE_RETRIES = 5;
const TOKEN_RACE_DELAY_MS = 20;

export async function readOrCreateToken(home: string): Promise<string> {
  const existing = await readToken(home);
  if (existing) return existing;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(tokenPath(home), `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // The file exists but is empty: another process may have created it and not written yet.
  for (let attempt = 0; attempt < TOKEN_RACE_RETRIES; attempt++) {
    await delay(TOKEN_RACE_DELAY_MS);
    const raced = await readToken(home);
    if (raced) return raced;
  }
  // Still empty (e.g. a crash between create and write): replace it atomically.
  const temp = `${tokenPath(home)}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, `${token}\n`, { mode: 0o600, flag: "wx" });
  await rename(temp, tokenPath(home));
  return token;
}

/** Loopback hosts a daemon URL may use. */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

export function localDaemonUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !(LOOPBACK_HOSTS as readonly string[]).includes(hostname)) {
    throw new Error("Mouthpiece daemon URL must use an HTTP loopback address");
  }
  return value;
}

export function daemonUrl(env: Env = process.env): string {
  return localDaemonUrl(
    env.MOUTHPIECE_URL || `http://127.0.0.1:${env.MOUTHPIECE_PORT || DEFAULT_PORT}`,
  );
}
