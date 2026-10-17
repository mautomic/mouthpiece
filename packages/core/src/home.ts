import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export async function readOrCreateToken(home: string): Promise<string> {
  const existing = await readToken(home);
  if (existing) return existing;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(tokenPath(home), `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    // Another process created it first: use theirs.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readToken(home);
    if (!raced) throw error;
    return raced;
  }
}

export function daemonUrl(env: Env = process.env): string {
  return env.MOUTHPIECE_URL || `http://127.0.0.1:${env.MOUTHPIECE_PORT || DEFAULT_PORT}`;
}
