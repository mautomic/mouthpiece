import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Config,
  parseConfig,
  type SettingsResponse,
  type SettingsUpdate,
  setTomlValue,
} from "@mouthpiece/core";
import { KOKORO_VOICES } from "@mouthpiece/providers";

export type SaveResult =
  | { ok: true; config: Config }
  | { ok: false; status: 400 | 409; error: string };

export function settingsOf(config: Config): SettingsResponse {
  return {
    chain: [...config.provider.chain],
    kokoro: {
      voice: config.provider.kokoro.voice,
      speed: config.provider.kokoro.speed,
      voices: KOKORO_VOICES.map((v) => ({ ...v })),
    },
  };
}

/**
 * Writes a settings change into the config file at `path`, keeping the rest of the file as
 * written, and returns the config it now holds. The file is only replaced once the edited text
 * parses and holds the new values; otherwise it is left alone (409).
 */
export async function saveSettings(path: string, update: SettingsUpdate): Promise<SaveResult> {
  const { voice, speed } = update.kokoro;
  if (voice !== undefined && !KOKORO_VOICES.some((v) => v.id === voice)) {
    return { ok: false, status: 400, error: `${voice} is not a Kokoro voice` };
  }
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    parseConfig(text, path);
  } catch (error) {
    return { ok: false, status: 409, error: `fix the config file first: ${errorMessage(error)}` };
  }
  let next = text;
  if (voice !== undefined) next = setTomlValue(next, "provider.kokoro", "voice", voice);
  if (speed !== undefined) next = setTomlValue(next, "provider.kokoro", "speed", speed);
  let config: Config | undefined;
  try {
    config = parseConfig(next, path);
  } catch {
    // Reported below: the file's layout (e.g. an inline table) is one the editor can't change.
  }
  const kokoro = config?.provider.kokoro;
  if (
    !config ||
    (voice !== undefined && kokoro?.voice !== voice) ||
    (speed !== undefined && kokoro?.speed !== speed)
  ) {
    return {
      ok: false,
      status: 409,
      error: `couldn't change [provider.kokoro] in ${path}; edit it by hand`,
    };
  }
  await mkdir(dirname(path), { recursive: true });
  // A symlinked config (e.g. from a dotfiles repo) is written through, so the link stays a link.
  const target = await realpath(path).catch(() => path);
  // Replace in one step, so the config watcher never reads a half-written file.
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, next);
  await rename(temp, target);
  return { ok: true, config };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
