# Mouthpiece

Mouthpiece reads your AI coding assistant's output aloud, so you don't have to watch the terminal.

When Claude Code (or Codex, Gemini CLI, or any script) finishes a response, Mouthpiece cleans it up, optionally condenses it into a sentence or two, and speaks it. Multiple sessions share one queue, so voices never overlap, and each project announces its name when more than one is talking. Speech pauses while you dictate and picks up where it left off.

It runs entirely on your Mac. The default voices are free: macOS `say`, or the local [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) model. Summaries use your Claude Code subscription through `claude -p`, so they don't add API charges.

```
 Claude Code ─┐  hooks
 Codex ───────┤                ┌───────────── mouthpiece daemon (127.0.0.1:7317) ──────────────┐
 Gemini CLI ──┼──────────────▶ │ clean → summarize → chunk → text-to-speech → one audio queue  │ ──▶ 🔊
 any script ──┘  HTTP / CLI    └────────────────────────────────────────────────────────────────┘
```

## Requirements

- macOS. Apple Silicon is recommended for the local Kokoro voice.
- [Bun](https://bun.sh) 1.2 or later, the native arm64 build on Apple Silicon. `install.sh` installs it if it's missing.
- Optional:
  - [Claude Code](https://claude.com/claude-code), for spoken responses and for summaries (`claude -p`, using your subscription).
  - Xcode Command Line Tools (`xcode-select --install`), to build the helper app that provides the hotkeys, menubar icon, pause-while-dictating, and gap-free playback.
  - An API key for Inworld, ElevenLabs, Deepgram, or OpenAI, if you want a cloud voice.

## Install

```sh
git clone git@github.com:mautomic/mouthpiece.git
cd mouthpiece
./install.sh
```

The installer is safe to re-run. It:

1. installs dependencies and links the `mouthpiece` command into `~/.local/bin`,
2. builds the helper app (hotkeys, menubar, mic pause),
3. offers to store an Inworld API key and to install the local Kokoro voice (~500 MB),
4. installs hooks for Claude Code, and for Codex and Gemini CLI if they're installed,
5. starts the daemon as a launchd agent, so it runs at login,
6. says "Mouthpiece is ready."

To preview the steps without changing anything, run `MOUTHPIECE_DRY_RUN=1 ./install.sh`.

To update later, run `git pull && ./install.sh`.

## Everyday use

Start a new Claude Code session. Responses are spoken as short summaries. When Claude needs your approval to use a tool, you hear an alert that names the project, even when responses are muted. Typing your next prompt interrupts whatever that session is saying.

| Hotkey | Action |
|---|---|
| ⌃⌥S | Stop speaking and clear the queue |
| ⌃⌥N | Skip to the next item |
| ⌃⌥R | Replay the last response |
| ⌃⌥M | Switch between summary and full |

The menubar icon shows whether Mouthpiece is idle, speaking, or paused, and how many items are queued. Its menu has the same controls, plus mode and pause, and a **Settings** submenu for the Kokoro voice and speed. A change there is saved to your config file and you hear the new voice right away.

**Pause while dictating:** speech pauses whenever another app is using the microphone (for example Wispr Flow or macOS Dictation), and resumes about 0.8 s after it stops, from the sentence it was on.

### Commands

```sh
mouthpiece say "Build finished."           # speak any text (also reads stdin, or --file path)
mouthpiece stop | skip                     # stop everything / skip the current item
mouthpiece replay [--full]                 # replay the last response (--full: unsummarized)
mouthpiece mode summary|full|off|toggle    # how responses are spoken (alerts are always spoken)
mouthpiece pause | resume                  # hold all speech, then continue where it left off
mouthpiece status                          # what the daemon is doing, as JSON
mouthpiece voices [--provider kokoro]      # list available voices
mouthpiece usage                           # characters, cost, and quotas this billing cycle
```

Run `mouthpiece` with no arguments for the full list.

## Voices

Speech goes through a **provider chain**: Mouthpiece uses the first provider, and falls back to the next one if it fails or is too slow. The chain always ends in macOS `say`, so you still hear something if everything else fails.

| Provider | Cost | Setup |
|---|---|---|
| `say` | free | built in |
| `kokoro` | free, runs locally | `mouthpiece kokoro install` (~500 MB) |
| `inworld`, `elevenlabs`, `deepgram`, `openai` | paid per character | `pbpaste \| mouthpiece auth <provider>` |

API keys are stored in the macOS Keychain. A `<PROVIDER>_API_KEY` environment variable (e.g. `ELEVENLABS_API_KEY`) is used first when it's set.

For example, to use Kokoro with `say` as the backup:

```toml
# ~/.config/mouthpiece/config.toml
[provider]
chain = ["kokoro", "say"]

[provider.kokoro]
voice = "af_heart"   # `mouthpiece voices --provider kokoro` lists all 28
speed = 1.2          # 0.5 to 2
```

You can also give each project its own voice, keyed on the project's directory name:

```toml
[voices.kokoro]
web = "bm_george"
api = "af_bella"
```

With the helper app built (`mouthpiece build-helper`), speech plays through a gap-free player: Kokoro starts speaking after the first sentence and continues without breaks between sentences. Without it, Mouthpiece plays each clip with `afplay`, which adds about a second between clips.

## Configuration

The config file is `~/.config/mouthpiece/config.toml`. It's optional: every setting has a default. Changes apply as soon as you save, without a restart. If the file can't be read (for example, a TOML syntax error), Mouthpiece says so, keeps the previous settings, and shows the error in `mouthpiece status`.

Commonly changed settings:

| Setting | Default | What it does |
|---|---|---|
| `provider.chain` | `["say"]` | Voices to try, in order |
| `modes.default` | `"summary"` | `summary`, `full`, or `off` |
| `summarizer.thresholdChars` | `300` | Responses shorter than this are spoken in full |
| `filter.minChars` | `20` | Shorter responses (and "done", "ok", …) aren't spoken |
| `hotkeys.stop` / `skip` / `replay` / `toggleMode` | `ctrl+alt+s` / `n` / `r` / `m` | Global hotkeys |
| `menubar.enabled` | `true` | Show the menubar icon |
| `micPause.enabled` | `true` | Pause while the mic is in use |
| `micPause.ignoreBundleIds` | `[]` | Apps whose mic use doesn't pause speech, e.g. `["us.zoom.xos"]` |
| `usage.quotas.<provider>` | none | e.g. `{ chars = 100000 }`: warn at 80%, switch to a free voice at 100% |
| `player.backend` | `"auto"` | `auto` plays through the gap-free player when it's built; `afplay` always uses afplay (restart the daemon after changing it) |

All settings and their defaults are in [`packages/core/src/config.ts`](packages/core/src/config.ts).

## Other sources

- **Codex:** `mouthpiece install-hooks --target codex`, then run `/hooks` in Codex to trust them.
- **Gemini CLI:** `mouthpiece install-hooks --target gemini`.
- **Tools without hooks:** `mouthpiece tail --format codex|gemini|lines` speaks new messages from a session log as they're written.
- **Anything else:** `mouthpiece say`, or POST to the local HTTP API:

  ```sh
  curl -s http://127.0.0.1:7317/v1/speak \
    -H "Authorization: Bearer $(cat ~/.mouthpiece/token)" \
    -H "Content-Type: application/json" \
    -d '{"text": "Deploy finished.", "source": "deploy-script"}'
  ```

  See [`docs/api.md`](docs/api.md) for every endpoint and field.

## Running the daemon

The daemon is a launchd agent (`dev.mouthpiece.daemon`). It starts at login and is restarted if it crashes. Its log is `~/.mouthpiece/daemon.log`.

```sh
mouthpiece daemon stop       # stop until next login (hooks stay silent meanwhile)
mouthpiece daemon start
mouthpiece daemon restart    # e.g. after pulling new code
```

When the daemon isn't running, hooks give up silently within 300 ms, so your coding tools are never slowed down or blocked.

## Uninstall

```sh
./uninstall.sh
```

This removes the daemon, every hook, the `mouthpiece` command, and the helper app. It asks before deleting the Inworld key, Kokoro, and your config and usage history. Delete any other stored key with `mouthpiece auth <provider> --delete`.

To remove pieces individually, use `mouthpiece uninstall-agent`, `mouthpiece uninstall-hooks [--target …]`, or `mouthpiece kokoro uninstall`.

## Development

```sh
bun install
bun run check                                     # lint, typecheck, and every test; run before committing
MOUTHPIECE_HOME=$(mktemp -d) bun run daemon       # an isolated daemon in the foreground
bun run mouthpiece -- say "hello"                 # the CLI from source
```

Tests never play audio or call paid APIs. Live tests run only with `MOUTHPIECE_LIVE_TESTS=1`.

- [`CLAUDE.md`](CLAUDE.md): the package layout, dependency rules, conventions, and guardrails.
- [`docs/PRD.md`](docs/PRD.md): the product spec, including the user stories (US-xxx) and functional requirements (FR-x) cited in commits.
- [`docs/api.md`](docs/api.md): the HTTP API.
- [`docs/spikes/conversation-mode.md`](docs/spikes/conversation-mode.md): notes on two-way voice conversation, a possible next step.
