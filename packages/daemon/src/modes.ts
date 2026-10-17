import type { Config, Mode, ModeRequest, ModeState, NormalizedSpeakEvent } from "@mouthpiece/core";

const GLOBAL = "*";
const keyFor = (source?: string, conversationId?: string) =>
  source === undefined
    ? GLOBAL
    : conversationId === undefined
      ? source
      : `${source}\u0000${conversationId}`;
const flip = (mode: Mode): Mode => (mode === "summary" ? "full" : "summary");

/** Runtime mode overrides (API/hotkeys) layered over config (US-010). */
export class ModeStore {
  #overrides = new Map<string, Mode>();

  constructor(
    private configDefault: Mode,
    private profiles: Config["profiles"],
  ) {}

  configure(configDefault: Mode, profiles: Config["profiles"]): void {
    this.configDefault = configDefault;
    this.profiles = profiles;
  }

  resolve(event: NormalizedSpeakEvent): Mode {
    return event.mode ?? this.#effective(event.source, event.conversationId);
  }

  apply(req: ModeRequest): ModeState {
    const key = keyFor(req.source, req.conversationId);
    if (req.clear) this.#overrides.delete(key);
    else
      this.#overrides.set(key, req.mode ?? flip(this.#effective(req.source, req.conversationId)));
    return this.state();
  }

  state(): ModeState {
    const overrides = [...this.#overrides]
      .filter(([key]) => key !== GLOBAL)
      .map(([key, mode]) => {
        const [source = "", conversationId] = key.split("\u0000");
        return conversationId === undefined ? { source, mode } : { source, conversationId, mode };
      });
    return { default: this.#overrides.get(GLOBAL) ?? this.configDefault, overrides };
  }

  #effective(source?: string, conversationId?: string): Mode {
    if (source !== undefined && conversationId !== undefined) {
      const conv = this.#overrides.get(keyFor(source, conversationId));
      if (conv) return conv;
    }
    if (source !== undefined) {
      const src = this.#overrides.get(source);
      if (src) return src;
    }
    return (
      this.#overrides.get(GLOBAL) ??
      (source !== undefined ? this.profiles[source]?.mode : undefined) ??
      this.configDefault
    );
  }
}
