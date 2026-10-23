# Mouthpiece

Mouthpiece reads your AI coding assistant's output aloud, so you don't have to watch the terminal.

When Claude Code (or Codex, Gemini CLI, or any script) finishes a response, Mouthpiece cleans it up, optionally condenses it into a short spoken summary, and speaks it. Multiple sessions share one queue, so voices never overlap, and each project announces its name when more than one is talking. Speech pauses while you dictate and picks up where it left off.

It runs entirely on your Mac. The default voice is free: the local [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) model (Heart, at 1.3×), with macOS `say` as the backup. Summaries use your Claude Code subscription through `claude -p`, so they don't add API charges.

```
 Claude Code ─┐  hooks
 Codex ───────┤                ┌───────────── mouthpiece daemon (127.0.0.1:7317) ──────────────┐
 Gemini CLI ──┼──────────────▶ │ clean → summarize → chunk → text-to-speech → one audio queue  │ ──▶ 🔊
 any script ──┘  HTTP / CLI    └────────────────────────────────────────────────────────────────┘
```

## Requirements

- macOS on Apple Silicon. Intel Macs are not supported.
- [Bun](https://bun.sh) 1.2 or later, the native arm64 build. `install.sh` installs it if it's missing and rejects an older or Rosetta Bun.
- Optional:
  - [Claude Code](https://claude.com/claude-code), for spoken responses and for summaries (`claude -p`, using your subscription).
  - Xcode Command Line Tools (`xcode-select --install`), to build the helper app that provides the hotkeys, menubar icon, pause-while-dictating, and gap-free playback.
  - An API key for Inworld, ElevenLabs, Deepgram, or OpenAI, if you want a cloud voice.

## Install

```sh
# HTTPS
git clone https://github.com/mautomic/mouthpiece.git
# Or, if you use GitHub SSH:
git clone git@github.com:mautomic/mouthpiece.git
cd mouthpiece
./install.sh --with-kokoro
```

`--with-kokoro` downloads the local Kokoro voice (~500 MB), a much better sounding voice than the
macOS `say` fallback — recommended unless you're short on disk or bandwidth. Start the daemon in the
foreground with `mouthpiece start`.

Add only the integrations you want:

```sh
./install.sh                # minimal local CLI setup only (macOS say voice)
./install.sh --with-helper  # hotkeys, menubar, mic pause, gap-free player
./install.sh --with-kokoro  # downloads the local Kokoro voice (~500 MB)
./install.sh --with-hooks   # Claude Code hooks, plus installed Codex/Gemini/Devin hooks
./install.sh --with-agent   # start at login through launchd
```

You can combine flags, for example: `./install.sh --with-helper --with-kokoro --with-hooks --with-agent`.

API keys are deliberately not requested during installation. If you choose a cloud provider later, run
`pbpaste | mouthpiece auth <provider>`.

To preview the steps without changing anything, run `MOUTHPIECE_DRY_RUN=1 ./install.sh`.

To update later, run `git pull && ./install.sh`.

### What installation changes

The default installer uses an existing Bun (`$BUN`, or the first `bun` on your PATH — e.g. from Homebrew) or
downloads one if none is found, installs the locked JavaScript dependencies, creates
`~/.local/bin/mouthpiece`, and writes a commented template at `~/.config/mouthpiece/config.toml` when none
exists. It does not start a background process, install hooks, download Kokoro, play audio, or
request an API key.

Each optional flag has a deliberate side effect:

| Flag | Change |
| --- | --- |
| `--with-helper` | Builds MouthpieceHelper and the audio player under `~/.mouthpiece`. macOS may ask for permissions needed by the enabled helper features. |
| `--with-kokoro` | Downloads the Kokoro model and package into `~/.mouthpiece/kokoro` (~500 MB). |
| `--with-hooks` | Adds only Mouthpiece hook entries to the settings files of installed supported tools; the installer keeps a backup before it changes one. |
| `--with-agent` | Writes `~/Library/LaunchAgents/dev.mouthpiece.daemon.plist` and starts the local daemon at login. |

The daemon listens only on loopback and protects every endpoint except its health check with a token stored at
`~/.mouthpiece/token` (owner-readable only). It uses the network only to install requested dependencies/models, to
call a cloud TTS provider you configure, or to run Claude Code summaries when enabled. See [SECURITY.md](SECURITY.md)
for responsible disclosure.

## Everyday use

Start a new Claude Code session. Responses are spoken as summaries:
- **Order:** first the most important results (what was done or found, and how it turned out), then anything you need to do or answer, at the end. If a summary is too long, sentences are cut from the middle, never the closing to-do.
- **Length:** short replies get a sentence or two, and complex ones get more, up to 700 characters.
- **Shorter replies:** a reply under 300 characters is read in full.

When Claude needs your approval to use a tool, you hear an alert that names the project, even when responses are muted. Typing your next prompt interrupts whatever that session is saying.

| Hotkey | Action |
|---|---|
| ⌃⌥S | Stop speaking and clear the queue |
| ⌃⌥N | Skip to the next item |
| ⌃⌥R | Replay the last response |
| ⌃⌥M | Switch between summary and full |
| ⌃⌥O | Open the reply inbox (with `[reply] enabled`) |

The menubar icon shows whether Mouthpiece is idle, speaking, or paused, how many items are queued, and "✉N" while N sessions wait in the inbox. Its menu has the same controls, each showing its hotkey, plus **Inbox**, mode and pause, and a **Settings** submenu for the Kokoro voice and speed. A change there is saved to your config file and you hear the new voice right away. **Quit Mouthpiece** (⌘Q while the menu is open) stops the daemon until your next login or `mouthpiece daemon start`.

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
mouthpiece inbox [--dismiss <label> | --clear]  # the latest response of each session (see below)
mouthpiece reply <label> "text"            # answer a session from the terminal (see below)
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

The default chain is Kokoro with `say` as the backup. Until Kokoro is installed, it's skipped and `say` speaks.
To change the voice or speed (the menubar's **Settings** does the same):

```toml
# ~/.config/mouthpiece/config.toml
[provider]
chain = ["kokoro", "say"]   # the default

[provider.kokoro]
voice = "af_heart"   # the default; `mouthpiece voices --provider kokoro` lists all 28
speed = 1.3          # the default; 0.5 to 2
```

You can also give each project its own voice, keyed on the project's directory name:

```toml
[voices.kokoro]
web = "bm_george"
api = "af_bella"
```

Or give each source its own voice. This is useful when several tools work in the same project:

```toml
[sourceVoices.kokoro]
claude-code = "af_bella"
codex = "am_adam"
devin = "bm_george"
```

Source voices are provider-specific, so add an equivalent `[sourceVoices.say]` map if `say` is a
regular fallback and you want it to remain distinct too. An event's explicit voice still wins, then
the source mapping, then a project-label mapping.

The menubar's Settings ▸ Source voices menu edits the same `[sourceVoices.kokoro]` map: it lists
every source the daemon knows, and a pick is written to the config file and heard right away.

With the helper app built (`mouthpiece build-helper`), speech plays through a gap-free player.
- **No pauses:** once speech starts, it never pauses mid-response.
- **Start time:** Kokoro renders ahead and starts as soon as the rest is sure to keep up. That's usually right after the first sentence, a little later when the response opens with a very short one.

Without the helper app, Mouthpiece plays each clip with `afplay`, which adds about a second between clips. To keep breaks rare, it sends Kokoro text in clips of up to 400 characters.

## Configuration

The config file is `~/.config/mouthpiece/config.toml`. It's optional: every setting has a default. Changes apply as soon as you save, without a restart. If the file can't be read (for example, a TOML syntax error), Mouthpiece says so, keeps the previous settings, and shows the error in `mouthpiece status`.

Commonly changed settings:

| Setting | Default | What it does |
|---|---|---|
| `provider.chain` | `["kokoro", "say"]` | Voices to try, in order (an uninstalled Kokoro is skipped) |
| `modes.default` | `"summary"` | `summary`, `full`, or `off` |
| `summarizer.thresholdChars` | `300` | Responses shorter than this are spoken in full |
| `summarizer.maxChars` | `700` | The longest a summary can be; each one is sized to its response (about 40% of its length) |
| `filter.minChars` | `20` | Shorter responses (and "done", "ok", …) aren't spoken |
| `hotkeys.stop` / `skip` / `replay` / `toggleMode` / `inbox` | `ctrl+alt+s` / `n` / `r` / `m` / `o` | Global hotkeys |
| `menubar.enabled` | `true` | Show the menubar icon |
| `reply.enabled` | `false` | Reply to sessions from the inbox (see "Replying to a session") |
| `reply.popup` | `"away"` | When the inbox pops up: `away`, `always` or `never` |
| `micPause.enabled` | `true` | Pause while the mic is in use |
| `micPause.ignoreBundleIds` | `[]` | Apps whose mic use doesn't pause speech, e.g. `["us.zoom.xos"]` |
| `usage.quotas.<provider>` | none | e.g. `{ chars = 100000 }`: warn at 80%, switch to a free voice at 100% |
| `player.backend` | `"auto"` | `auto` plays through the gap-free player when it's built; `afplay` always uses afplay (restart the daemon after changing it) |
| `[[follow]]` | none | Tail followers to run with the daemon, e.g. `format = "margin"`, plus optional `path`, `source` and `label`, as for `mouthpiece tail` (restart the daemon after changing it) |

All settings and their defaults are in [`packages/core/src/config.ts`](packages/core/src/config.ts).

## Other sources

- **Codex:** `mouthpiece install-hooks --target codex`, then run `/hooks` in Codex to trust them.
- **Gemini CLI:** `mouthpiece install-hooks --target gemini`.
- **Tools without hooks:** `mouthpiece tail --format codex|gemini|lines` speaks new messages from a session log as they're written.
- **Margin:** `mouthpiece tail --format margin` speaks an agent's replies in [Margin](https://github.com/ariboren/margin) reviews, named by document ("PRD: Agreed, …"). It follows each document while a Margin tab shows it (asking Margin's local server every 2 s), or one document with `--path <doc.md>`, and never speaks your own comments. To run it with the daemon, add to your config and run `mouthpiece daemon restart`:

  ```toml
  [[follow]]
  format = "margin"
  ```

  `mouthpiece mode off --source margin` mutes it.
- **Anything else:** `mouthpiece say`, or POST to the local HTTP API:

  ```sh
  curl -s http://127.0.0.1:7317/v1/speak \
    -H "Authorization: Bearer $(cat ~/.mouthpiece/token)" \
    -H "Content-Type: application/json" \
    -d '{"text": "Deploy finished.", "source": "deploy-script"}'
  ```

  To add your own source, send:
  - `source`: a fixed name for your tool, e.g. `deploy-script`;
  - `label`: what's spoken first, e.g. `"deploy"` → "deploy: …";
  - `conversationId`: a new message replaces an unplayed one with the same id, so use a unique id per message you don't want replaced;
  - `verbatim: true`: speak your text exactly, never summarized (for text you've already written to be heard);
  - `announce: "always"`: say the label every time, not only when several sessions are talking.

  Override a source's announce in your config, and give its label its own voice:

  ```toml
  [profiles."deploy-script"]
  announce = "never"   # "never" | "auto" | "always"

  [voices.kokoro]
  deploy = "am_michael"
  ```

  `mouthpiece mode off --source deploy-script` mutes it. See [`docs/api.md`](docs/api.md) for every endpoint and field.

## Replying to a session (Orca)

Mouthpiece keeps the latest response of each session in an inbox. When a session runs in an Orca terminal, you can
answer it without finding its tab: the reply is typed at its prompt and submitted.

```toml
[reply]
enabled = true      # off by default
```

```sh
mouthpiece inbox                      # the latest response of each session
mouthpiece reply web "yes, run the migration"
```

Mouthpiece only types into a session that is waiting for you, is still the same agent, is idle, and has an empty
prompt; anything it can't check is refused, never typed blind. A reply is joined into one line. "typed, not submitted"
means Mouthpiece couldn't confirm the agent started; check the terminal, or run `mouthpiece reply --submit <id>`.
Works with Claude Code and Codex sessions. `enabled` applies without a restart. The Orca CLI path is
`[reply] orca`, by default Orca's bundled one; it is read when the daemon starts.

### The inbox panel

With `[reply] enabled`, the helper app shows an inbox panel in the native macOS look (translucent, light or dark with
the system): a tab per session, the selected response (a long one cut to its first lines, with **Show full response** to expand it), and a reply box. ⌃⌥O (or the menubar's **Inbox**)
opens it on the newest session waiting for you. ⌘↩ sends (↩ adds a line), ⌘1–⌘9 or ⌃⇥ switch tabs, Esc closes.
A new response pops up when its voice starts, not before; until then its tab reads "Speaking soon…". One that
won't be spoken (muted, skipped) pops up at once.

```toml
[reply]
popup = "away"      # pop up on a new response unless the session's terminal app (Orca) is in front;
                    # "always" pops on every one; "never" only opens on ⌃⌥O or from the menubar
[hotkeys]
inbox = "ctrl+alt+o"
```

You can dictate into the reply box (Wispr Flow included) and use ⌘V, ⌘C, ⌘A and ⌘Z there. Open the panel with ⌃⌥O
first, so it's the app in front.

A tab's **×** (or ⌘⌫ in an empty reply box) removes it, and **Clear all** (in the panel's ··· menu) empties the inbox (from the CLI: `mouthpiece inbox --dismiss <label>`
or `--clear`). A session's next response brings it back.

A pop-up never takes your keystrokes, and hides after 20 seconds if you don't touch it. Orca can't say which tab
you're looking at, so while Orca is in front, "away" stays quiet for every Orca session.
Rebuild the helper after updating (`mouthpiece build-helper`, then `mouthpiece daemon restart`).

## Running the daemon

The daemon is a launchd agent (`dev.mouthpiece.daemon`). It starts at login and is restarted if it crashes. Its log is `~/.mouthpiece/daemon.log`.

```sh
mouthpiece daemon stop       # stop until next login (hooks stay silent meanwhile)
mouthpiece daemon start      # also after the menubar's Quit
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

- [`CLAUDE.md`](CLAUDE.md) (also `AGENTS.md`): the package layout, dependency rules, conventions, and guardrails for coding agents.
- [`docs/PRD.md`](docs/PRD.md): the product spec, including the user stories (US-xxx) and functional requirements (FR-x) cited in commits.
- [`docs/api.md`](docs/api.md): the HTTP API.
- `docs/*-checklist.md`: the manual test checklists (things only a person can check, like how speech sounds).
- [`docs/spikes/conversation-mode.md`](docs/spikes/conversation-mode.md): notes on two-way voice conversation, a possible next step.
