import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { type Config, loadConfig } from "@mouthpiece/core";

export interface WatchOptions {
  onChange(config: Config): void | Promise<void>;
  onError(error: unknown): void;
  debounceMs?: number;
}

/** Hot reload (FR-11). Watches the directory (editors replace files); invalid config is reported, never applied. */
export function watchConfig(path: string, opts: WatchOptions): () => void {
  const file = basename(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let watcher: FSWatcher;
  try {
    watcher = watch(dirname(path), (_event, name) => {
      if (stopped || name !== file) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const config = await loadConfig(path);
          // A reload that was in flight when stop() ran must not apply.
          if (!stopped) await opts.onChange(config);
        } catch (error) {
          if (!stopped) opts.onError(error);
        }
      }, opts.debounceMs ?? 200);
    });
    watcher.on("error", (error) => {
      if (!stopped) opts.onError(error);
    });
  } catch (error) {
    opts.onError(error);
    return () => {};
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
    watcher.close();
  };
}
