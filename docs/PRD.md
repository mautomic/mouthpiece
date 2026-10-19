# PRD: Mouthpiece

> **Status:** v0.5 · Phases 0–4 and the reply inbox (Phase 5: US-024 to US-026) implemented and on `main`; US-027 open. Plans and decisions: `docs/superpowers/plans/`, designs: `docs/superpowers/specs/`.
> **Date:** 2026-10-18
> **Owner:** @mautomic

## 1. Introduction

Speech-to-text (Wispr Flow) has made *talking to* Claude Code much faster than typing: more thoughts and more detail for the same time spent. Output still only comes back one way: I have to read it. That forces me to watch the terminal, so I can't step away, pace, look at another monitor, or keep several sessions going while doing something else.

**Mouthpiece is the other half of the loop.** It's a small local service that listens for output from Claude Code (and other AI CLIs or any script), optionally condenses it into something worth hearing, and reads it aloud through a third-party text-to-speech (TTS) provider. A local voice is the fallback.

```
 ┌──────────────┐  Stop / Notification hooks   ┌───────────────────────────────────────────────┐
 │ Claude Code  │ ───────────────────────────▶ │                mouthpieced                    │
 │  session(s)  │   (async, never blocks CC)   │                (local daemon)                 │
 └──────────────┘                              │                                               │
 ┌──────────────┐  notify hook / adapter       │  ingest → clean → [summarize] → chunk → TTS   │
 │ Codex/Gemini │ ───────────────────────────▶ │                                  │            │
 └──────────────┘                              │                     audio queue ◀┘            │
 ┌──────────────┐  `mouthpiece say` / POST     │           (priority, interrupt, replay)       │
 │ any script   │ ───────────────────────────▶ │                         │                     │
 └──────────────┘                              └─────────────────────────┼─────────────────────┘
                                                                         ▼
                                                             speakers / headphones
```

## 2. Goals

- **G1:** Hear a spoken version of every Claude Code response without looking at the terminal, starting soon after the response finishes:
  - **< 1.5 s** in full mode
  - **< 4 s** in summary mode with the subscription summarizer (§8.5)
- **G2:** Two speech modes that can be switched on the fly:
  - **summary** (default): a short spoken summary, sized to the response (updated 2026-10-17; it was 1–3 sentences). It leads with any question for the user and anything they need to do. See US-009.
  - **full**: the whole response with markdown and code cleaned out.
  - "Replay the full version of the last message" is always available.
- **G3:** Never slow down or block Claude Code. Hooks are fire-and-forget, and a dead daemon degrades silently.
- **G4:** Handle multiple concurrent sessions without audio overlapping. You always know which project is talking.
- **G5:** Provider-agnostic TTS layer: swapping ElevenLabs / Inworld / Deepgram / OpenAI / macOS `say` is a config change.
- **G6:** Keep it cheap and visible: **≤ $50/month** at heavy personal usage in summary mode. Track character usage per provider and project against each plan's quota (used / remaining / projected), warn at 80%, and fall back to a free voice at 100%.
- **G7:** Source-agnostic core: one entry point that anything can use (`mouthpiece say` / `POST /v1/speak`). Claude Code is just the first adapter, and other sources (a Discord bot, cron jobs, CI, other AI CLIs) are thin adapters onto the same pipeline (§8.3).
- **G8 (added 2026-10-17):** Once speech starts, it never pauses mid-response. When starting sooner would risk a pause, start later. With a local model (Kokoro), this trades the G1 targets for continuity.

## 3. Decisions made so far

| Topic | Decision | Notes |
|---|---|---|
| Speech mode | **Both, switchable**, with summary as the default | Toggle per session or globally. "Replay full" command. |
| Architecture | **Local daemon + Claude Code hooks** | The daemon owns the queue, TTS, and playback. Clients only POST text. v1 uses user-scope hooks; a plugin is the distribution path (§4.4). |
| Stack | **TypeScript on Bun** | Fast startup, built-in HTTP server and SQLite, good TTS SDKs. Node-compatible. |
| v1 sources | **Claude Code**, **generic HTTP/CLI**, **other AI CLIs** | Clipboard/selection reading is deferred. |
| Summarizer | **Claude Haiku via `claude -p --model haiku`** on the logged-in Claude subscription (no API key, no extra billing; counts toward plan limits). Optional API-key path for lower latency. | $0 extra on the subscription; about $0.70/month on the API-key path (see §9.2). Recursion guarded by `MOUTHPIECE_CHILD=1`. |
| TTS rollout | **macOS `say` for the MVP**, then **Inworld TTS-2 Flash** as the first paid provider | `say` is free and needs no keys, so the whole pipeline gets built first. Kokoro comes later as a free upgrade (US-019). |

## 4. How we hook into Claude Code (research findings)

**Short answer: yes, the harness supports this directly.** Hooks are configured in `settings.json` or shipped inside a **plugin**.

### 4.1 Relevant hook events

| Event | When it fires | Mouthpiece use |
|---|---|---|
| **`Stop`** | Main agent finishes a response. Not fired on user interrupt. API errors fire `StopFailure` instead. | **Primary trigger.** Speak the response. |
| `SubagentStop` | A subagent finishes. | Optional and off by default. Too noisy. |
| **`Notification`** | `permission_prompt` (Claude needs approval, about 6 s after the prompt shows) and `idle_prompt` (about 60 s idle after finishing). | Speak a short "*\<project\> needs your approval*" alert. |
| **`UserPromptSubmit`** | The user submits a new prompt. | **Barge-in:** stop or flush audio for that session. Once you've replied, the old response is stale. |
| `SessionStart` / `SessionEnd` | Session lifecycle. | Register or unregister the session with the daemon (name, voice assignment). |
| `MessageDisplay` | Assistant text is displayed. *Fields unverified.* | **Future:** stream speech while Claude is still writing. |
| `StopFailure` | The turn ended in an API error. | Optional: "*\<project\> hit an error*". |

### 4.2 The Stop payload already contains the text

The documented `Stop` stdin JSON includes `last_assistant_message`, so **no transcript parsing is required.** The docs recommend this field over reading `transcript_path`, because the transcript JSONL may not be flushed when the hook runs.

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/<proj>/<session>.jsonl",
  "cwd": "/Users/Mau/code/projects/foo",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "I've completed the refactoring..."
}
```

Fallback if the field is ever missing: read the transcript JSONL and take the `text` blocks of the last `type == "assistant"` record. The JSONL schema is undocumented and may change, so this is fallback only.

### 4.3 Configuration shape

The `async: true` flag makes the hook non-blocking: Claude Code doesn't wait for it, and async hooks have no timeout.

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/mp-hook stop", "async": true }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt|idle_prompt",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/mp-hook notify", "async": true }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/mp-hook prompt", "async": true }] }
    ]
  }
}
```

- **Hook types available:** `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- **The `http` type could POST straight to the daemon,** with no shell script in between. Its body format is unverified; see spike US-001.
- **The thin hook client must:**
  1. Read stdin.
  2. POST to `127.0.0.1:<port>/v1/events` with a ~300 ms timeout.
  3. Exit 0 no matter what. If the daemon is down, skip silently or optionally fall back to `say`.

### 4.4 Packaging: clone + install script first, plugin later

Mouthpiece only needs its hook entries registered with Claude Code. There are two ways to get them there; the hook script and daemon are identical either way.

**v1: clone + install script, using user-scope hooks.**
- Setup is three commands: `git clone …/mouthpiece && cd mouthpiece && ./install.sh`.
- The script checks prerequisites, runs `bun install`, and links the CLI into `~/.local/bin`.
- It writes the config and token, installs the launchd agent, and runs `mouthpiece install-hooks`.
- It optionally stores a TTS key in the Keychain, then speaks a test line.
- `mouthpiece install-hooks` merges the §4.3 entries into `~/.claude/settings.json`, pointing at the repo's `bin/mp-hook`. Slash commands go in `~/.claude/commands/`.
- `./uninstall.sh` reverses everything. `git pull && ./install.sh` updates, and every step is idempotent.
- No plugin machinery is involved. The hooks apply to every project, and iteration is fast.

**Later: Claude Code plugin + marketplace (US-023).**
- Users install with `/plugin marketplace add mautomic/mouthpiece` followed by `/plugin install mouthpiece`.
- The plugin bundles the hooks, slash commands, and `mp-hook`.
- The daemon and CLI ship separately as a compiled `mouthpiece` binary (Homebrew tap or GitHub release). The same binary serves Codex, Gemini, and pipe users.
- If the binary is missing, the plugin's `SessionStart` hook prints the one-line install command.

Plugin layout:

```
mouthpiece-plugin/
├── .claude-plugin/plugin.json
├── hooks/hooks.json            # same shape as settings.json "hooks"
├── commands/                   # /mouthpiece:mode, :mute, :replay, :voice …
└── bin/mp-hook                 # tiny client → daemon
```

- Use `${CLAUDE_PLUGIN_ROOT}` for paths and `${CLAUDE_PLUGIN_DATA}` for state.
- Develop with `claude --plugin-dir ./mouthpiece-plugin`.

### 4.5 Gotchas

- **Stop fires on every main-agent turn,** including tiny "Done." responses. Add a minimum-length / "worth speaking" filter.
- **Never return `decision: "block"`.** Mouthpiece is observe-only, so `stop_hook_active` loops can't happen.
- **Nested `claude -p` loops.** The summarizer shells out to `claude -p`, which loads our own Stop hook, so the hook would try to speak the summarizer's output. `--bare` would skip hooks, but it requires `ANTHROPIC_API_KEY`, which defeats using the subscription. Instead, the daemon sets `MOUTHPIECE_CHILD=1` in the child's environment and every `mp-hook` exits immediately when that variable is set.
- **Async hooks are killed when a `claude -p` run tears down.** The hook must hand off to the daemon quickly. The daemon does the slow work.
- **Useful env vars:** `CLAUDE_PROJECT_DIR`, used for the project name and per-project voice.

### 4.6 Alternatives considered (not chosen)

| Option | Why not |
|---|---|
| Statusline script | Gets session and cost metadata but no message text. |
| Output styles | Only changes what Claude writes. *Could* be paired with Mouthpiece to make Claude end responses with a "TL;DR for speech" line, removing the summarizer call. **Worth an experiment** (see Open Questions). |
| `claude -p --output-format stream-json` | Only works for sessions we launch ourselves, not interactive ones. |
| Agent SDK hooks | Only for apps built on the SDK. Relevant if Mouthpiece later wraps its own agent. |
| Tailing transcript JSONL with fswatch | Works without hooks, but relies on an undocumented format and has flush-timing races. Kept as a fallback adapter only. |

### 4.7 Codex integration insights (research, 2026-10-17)

**Codex supports the same core integration shape:** a `Stop` lifecycle hook receives
`last_assistant_message`, the completed assistant text for the turn. The adapter can send
that text to `mouthpieced`; it does not need to parse a transcript. Codex does expose a
`transcript_path` as a convenience, but the transcript format is explicitly not a stable
hook interface, so it is fallback-only.

| Need | Codex mechanism | Mouthpiece implication |
|---|---|---|
| React after an answer finishes | `Stop` hook | **Primary Codex adapter trigger.** Send `last_assistant_message` to the daemon. |
| Never hold up the agent loop | Background command hook (`async: true`) | The hook should hand off to the local daemon quickly and tolerate failure. Background hooks are cancelled when the session ends, so the daemon—not the hook—owns all slow TTS work. |
| Call a hosted TTS provider | Command hook or an already-connected MCP tool | Prefer the thin local hook client → daemon route; an MCP server can later provide an authenticated, structured TTS tool. |
| Repeat the summary → TTS workflow intentionally | Skill + TTS MCP tool/CLI | A skill can guide Codex to produce a speech-ready summary and call TTS when the user invokes it (for example, `$voice-summary`). |
| Fully automatic summary → TTS after every answer | `Stop` command/MCP hook | Hooks cannot automatically invoke a second skill: the current `prompt` and `agent` hook handlers are parsed but skipped. Put automatic summarization in the daemon/service instead. |

A Codex `Stop` hook gets, at minimum, the `session_id`, `cwd`, `turn_id`,
`stop_hook_active`, and `last_assistant_message` fields. It fires for each completed turn,
so the existing trivial-response filter is necessary. `Stop` does **not** support a matcher;
the adapter must decide in its client/daemon whether the message is worth speaking.

Example adapter shape (exact configuration and payload still get a small smoke test in
US-014):

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "mp-hook codex-stop",
        "async": true,
        "timeout": 3
      }]
    }]
  }
}
```

- Configure Codex hooks in `~/.codex/hooks.json`, `~/.codex/config.toml`, or the trusted
  project `.codex/` layer. Codex requires review/trust for non-managed hooks (`/hooks`).
- Command hooks and local configuration are unavailable in some cloud-orchestrated Codex
  setups; retain `mouthpiece say` / HTTP as the universal fallback entry point.
- Do not make automatic speech depend on a skill. Skills are the reusable *instruction*
  layer; MCP servers and command hooks are the controlled action layer.

## 5. User Stories

Stories are grouped by phase. Each should fit in one focused session.

### Phase 0: Spikes (de-risk before building)

#### US-001: Verify hook payloads end-to-end
**Description:** As the developer, I want to capture real `Stop`, `Notification`, and `UserPromptSubmit` payloads so the daemon's input contract is based on facts, not docs.

**Acceptance Criteria:**
- [ ] A throwaway hook dumps stdin JSON to `~/.mouthpiece/spike/<event>-<ts>.json`
- [ ] Confirmed: `last_assistant_message` is present on Stop, both for responses that include tool use and for those that don't
- [ ] Confirmed: Notification `notification_type` values and the `message` text
- [ ] Tested the `http` hook type against a local echo server; recorded the request body and headers in `docs/hook-payloads.md`
- [ ] Measured hook overhead (the time Claude Code waits) with `async: true`: target ≈ 0 ms

#### US-002: TTS and summarizer latency spike
**Description:** As the user, I want to hear `say` and Inworld side by side and see measured latencies, so I can confirm the rollout plan and pick voices by ear and by numbers.

**Acceptance Criteria:**
- [ ] A script synthesizes three fixed samples (a short status line, a ~400-character summary, and a ~2,000-character response) on:
  - macOS `say` (try 2–3 of the premium or Siri voices)
  - Inworld TTS-2 Flash and TTS-2
- [ ] Records time to first byte and total time for each, measured from this machine
- [ ] Measures `claude -p --model haiku` summary latency: cold-start median and p90 over 10 runs, compared with a direct API call
- [ ] Saves the audio files plus a `results.md` table
- [ ] Records my ranking and chosen voices in this PRD
- [ ] Deepgram Aura-2, ElevenLabs Flash or v4 Turbo, and OpenAI are added to the bake-off **only if** Inworld disappoints on quality or latency

### Phase 1: MVP (speak Claude Code responses verbatim)

#### US-003: Daemon skeleton
**Description:** As a user, I want a background daemon that accepts text over local HTTP so any client can make it speak.

**Acceptance Criteria:**
- [ ] `mouthpieced` (Bun) listens on `127.0.0.1:7317`, configurable, and **binds to loopback only**
- [ ] `GET /v1/health` returns `{ ok, version, provider, queueDepth }`
- [ ] `POST /v1/speak` accepts the generic event envelope (§8.3) and returns `202` immediately:
  ```ts
  { text, source, conversationId?, label?, kind?, priority?, mode?, format? }
  ```
  No field names are specific to Claude Code.
- [ ] Requires a shared token stored in `~/.mouthpiece/token`, so other local processes and web pages can't trigger speech. The CLI and hooks read the same file.
- [ ] Typecheck and lint pass; unit tests cover request validation

#### US-004: Text cleaning for speech
**Description:** As a listener, I want markdown noise removed so I don't hear "asterisk asterisk" or code read aloud character by character.

**Acceptance Criteria:**
- [ ] Removes markdown syntax: headers, emphasis, links (keeps the link text), and table pipes
- [ ] Fenced code blocks become "*(code block, N lines)*". Inline code is kept unless it is longer than 40 characters.
- [ ] Long absolute paths are shortened to their basename ("`/Users/Mau/code/x/src/foo.ts`" → "foo.ts")
- [ ] Bare URLs become their domain ("link to github.com")
- [ ] Golden-file tests cover at least 10 real Claude Code responses captured in US-001

#### US-005: TTS provider interface + first provider + playback
**Description:** As a user, I want cleaned text synthesized and played through my speakers, with playback starting before the whole clip is generated.

**Acceptance Criteria:**
- [ ] Defines a `TtsProvider` interface:
  ```ts
  synthesize(text, voice, opts): AsyncIterable<Uint8Array>
  ```
  plus `name`, `formats`, `maxCharsPerRequest`, and `pricePerMillionChars`
- [ ] Implements the `say` provider first; it is the MVP default
- [ ] Implements Inworld TTS-2 Flash as the first cloud provider
- [ ] Splits text at sentence boundaries to respect each provider's request limit
- [ ] Plays Inworld audio as it arrives, by piping PCM to a native player or playing chunked mp3. First audio within 700 ms of the request.
- [ ] Falls back to `say` and logs a warning when Inworld errors, takes more than 3 s to the first byte, or has no API key set

#### US-006: Audio queue with no overlap
**Description:** As a user running several sessions, I never want two voices talking over each other.

**Acceptance Criteria:**
- [ ] One playback at a time. Other items are queued.
- [ ] Each item is prefixed with the project name when more than one session has been active in the last 10 minutes ("*mouthpiece: …*")
- [ ] **Coalescing:** a new item from the same session replaces that session's queued (not yet playing) item
- [ ] Priorities: `alert` (Notification) jumps ahead of `response`, but does not interrupt the item currently playing
- [ ] Queue items expire after 5 minutes unplayed (configurable)

#### US-007: Claude Code hook client
**Description:** As a Claude Code user, I want responses spoken automatically after each turn.

**Acceptance Criteria:**
- [ ] The `mp-hook stop` script reads stdin, extracts `last_assistant_message`, `session_id`, and `cwd`, and POSTs to the daemon with a 300 ms timeout
- [ ] Always exits 0. It never writes to stdout, because stdout could be read as a hook decision.
- [ ] Exits immediately and sends nothing when `MOUTHPIECE_CHILD=1` is set, so summarizer runs are never spoken
- [ ] Skips responses shorter than N characters or matching a "trivial" list (`Done.`, `OK`), configurable
- [ ] Manual test: in a real session, a response is spoken and Claude Code's prompt is immediately interactive

#### US-008: Barge-in on new prompt
**Description:** As a user, when I start my next prompt I want the old response to stop talking.

**Acceptance Criteria:**
- [ ] Any source can send `POST /v1/interrupt { source, conversationId }`. The Claude Code `UserPromptSubmit` hook is the first caller.
- [ ] Stops playback if that conversation's item is playing, and drops its queued items. Other conversations are unaffected.
- [ ] `mouthpiece stop` (all sessions) and `mouthpiece skip` (current item only) work from any terminal

### Phase 2: Summary mode, modes, Claude Code install

#### US-009: Summarizer
**Description:** As a listener, I want long responses condensed into a short spoken summary that tells me what happened and what (if anything) Claude needs from me.

**Acceptance Criteria:**
- [ ] **Default backend:** runs `claude -p --model haiku` on the logged-in subscription, with no API key
  - The child process gets `MOUTHPIECE_CHILD=1` in its environment (recursion guard; see §4.5)
  - Tools are disabled for the child, and the summarize prompt is passed on stdin
- [ ] **Optional backend:** calls `claude-haiku-5-5` through `@anthropic-ai/sdk` with `effort: "low"`, used only when `summarizer.backend = "api"` and a key is configured
- [ ] Both backends share one prompt. Updated 2026-10-17: the target is sized to the response, about 40% of its length, at least 200 characters and at most `summarizer.maxChars` (default 700, was 350).
- [ ] The prompt leads with **the most important results** (what was done or found and how it turned out), leaving out minor details. It ends with **anything the user needs to do** (restart something, run a command, try a change), including any question or decision for them.
  - Updated 2026-10-18 at the user's request. It was questions first, then to-dos, then results.
  - It never drops a question or a to-do, and never reads code, file paths, commit ids or exact counts aloud.
  - An over-long summary is trimmed from the middle, so the closing to-do always survives.
- [ ] Responses already shorter than the summary threshold (~300 characters after cleaning) skip the LLM call
- [ ] Falls back to the first ~2 sentences of the cleaned text on error or timeout. Defaults: 12 s for `claude -p` (measured 2–8 s, longer for complex replies; was 6 s), 2.5 s for the API.
- [ ] Stores both the summary and the full cleaned text for each item, for replay
- [ ] Eval: 20 captured responses, summaries hand-reviewed; at least 18 of 20 judged "I'd act the same as if I'd read it"

#### US-010: Mode switching + replay
**Description:** As a user, I want to flip between summary and full, and hear the full version of the last message on demand.

**Acceptance Criteria:**
- [ ] Mode can be set globally and per session: `mouthpiece mode summary|full|off [--session <id>]`
- [ ] `mouthpiece replay [--full]` replays the last item, served from the audio cache when possible
- [ ] Audio cache is keyed by `sha256(provider|voice|text)` with an LRU size cap (default 200 MB)
- [ ] `off` mode still plays `alert` items unless `--mute-alerts` is set

#### US-011: Clone + install script, Claude Code hooks
**Description:** As a new user, I want to clone the repo, run one script, and hear Mouthpiece working, without hand-editing settings.json or installing a plugin.

**Acceptance Criteria:**
- [ ] `./install.sh` checks for macOS and Bun (offers to install Bun if missing), then runs `bun install` and links `mouthpiece` into `~/.local/bin`
- [ ] It creates the config and shared token, installs and loads the launchd agent, and runs `mouthpiece install-hooks`
- [ ] It optionally prompts for an Inworld API key and stores it in the Keychain. Skipping keeps `say` as the provider.
- [ ] It ends by speaking "*Mouthpiece is ready*" and printing next steps
- [ ] Re-running it is safe (idempotent); `git pull && ./install.sh` is the update path
- [ ] `./uninstall.sh` unloads the agent, removes the hooks, commands, and CLI link, and asks before deleting the config and cache
- [ ] Tested on a clean macOS user account
- [ ] `mouthpiece install-hooks` merges the Stop, Notification, UserPromptSubmit, and SessionStart entries into `~/.claude/settings.json`
  - Backs up the file first
  - Is idempotent and keeps existing hooks
- [ ] `mouthpiece uninstall-hooks` removes only Mouthpiece's entries
- [ ] Installs slash commands to `~/.claude/commands/`: `/mouthpiece-mode <summary|full|off>`, `/mouthpiece-replay`, `/mouthpiece-mute`, and `/mouthpiece-voice <name>`
- [ ] If the daemon isn't running, `SessionStart` prints one line of context ("Mouthpiece daemon not running: `mouthpiece start`") and doesn't try again that session

#### US-012: Spoken alerts from Notification
**Description:** As a user who has walked away, I want to hear when a session is blocked on me.

**Acceptance Criteria:**
- [ ] `permission_prompt` speaks "*\<project\> needs approval*" and includes the tool name when the message contains it
- [ ] `idle_prompt` is off by default (the response was already spoken). It can be configured.
- [ ] De-duplicates repeated alerts within a 60-second window

### Phase 3: Breadth

#### US-013: Generic CLI + pipes
**Description:** As a user, I want any script to make Mouthpiece talk.

**Acceptance Criteria:**
- [ ] `mouthpiece say "text"`, `cmd | mouthpiece say`, and `mouthpiece say --file x.md` all work
- [ ] `--mode`, `--voice`, `--priority`, and `--source` flags
- [ ] Exits non-zero with a helpful message if the daemon is down. `--fallback-say` makes it speak locally instead.

#### US-014: Other AI CLI adapters
**Description:** As a user of Codex, Gemini CLI, and other AI CLIs, I want the same spoken experience as in Claude Code.

**Acceptance Criteria:**
- [ ] **Codex CLI:** a `Stop` lifecycle-hook adapter that reads `last_assistant_message`, `session_id`, and `cwd`, then hands off to the same local daemon contract. It must not parse `transcript_path` except as a documented fallback.
- [ ] **Codex CLI:** documents hook location, trust review (`/hooks`), and the limitation that local command hooks are unavailable in some cloud-orchestrated environments.
- [ ] **Gemini CLI:** an adapter for its hooks system (*verify event names and payload*)
- [ ] **Fallback adapter:** tails a JSONL or log file with a per-tool parser, for tools without hooks
- [ ] Each adapter has an install doc and maps into the same `POST /v1/speak` contract

*2026-10-18:* the fallback tailer also reads Margin review logs (`.margin/<doc>.jsonl`): an agent's replies are spoken, named by document, while a Margin tab shows it. `[[follow]]` in the config runs any tail format with the daemon (spec `docs/superpowers/specs/2026-10-18-margin-speech-design.md`).

#### US-015: Additional providers
**Description:** As a user, I want to switch providers or voices by config to trade quality, cost, and latency.

**Acceptance Criteria:**
- [ ] At least 3 cloud providers plus `say` implemented behind `TtsProvider`
- [ ] Per-project voice mapping in config, so each project sounds distinct
- [ ] `mouthpiece voices [--provider x]` lists the available voices

#### US-016: Usage meter, quota tracking + budget cap
**Description:** As the person paying, I want to see character usage against each plan's quota and never get a surprise bill.

**Acceptance Criteria:**
- [ ] Every synthesis logs a row to SQLite: provider, voice, project, characters, cache hit or miss, and estimated cost
- [ ] Every summarizer call is logged too: backend, duration, and tokens when they are available
- [ ] Config holds each provider's plan, for example:
  ```toml
  [quota.inworld]
  chars = 0
  free_minutes = 70
  resets = "monthly"
  ```
  plus the billing-cycle start day and a monthly dollar budget
- [ ] `mouthpiece usage [--month]` shows, per provider and per project:
  - characters used, remaining quota, and % used
  - days left in the billing cycle
  - projected month-end usage and cost at the current rate
- [ ] Syncs with provider usage endpoints when they exist, for example ElevenLabs' subscription character count and limit; *verify each provider*. The local counter remains the source of truth.
- [ ] At 80% of quota or budget, prints a CLI warning and speaks a one-time notice
- [ ] At 100%, switches to the fallback provider (default `say`) and speaks a one-time notice

### Phase 4: Polish (stretch)

- **US-017:** Global hotkeys for stop, skip, replay, and mode toggle (via `skhd`/Hammerspoon or a tiny Swift helper). **Moved to Phase 2** (2026-10-17): users need a one-key way to stop speech; interim workaround is a macOS Shortcuts hotkey running `mouthpiece stop`.
- **US-018:** Menubar indicator: speaking, idle, or muted; queue depth; current provider. *Implemented.* Its Settings submenu changes the Kokoro voice and speed and saves them to the config file (`POST /v1/settings`).
- **US-019:** Local high-quality TTS (Kokoro-82M) as a $0 provider. *Implemented* with `kokoro-js` (ONNX, q8), not MLX/Core ML. Since 2026-10-19 it's the default voice (Heart, `af_heart`, at 1.3×; chain `["kokoro", "say"]`), and `install.sh` installs it unless you answer no.
  - Installed by `mouthpiece kokoro install`.
  - Runs in a child process, so a render can be killed mid-way.
  - Has a configurable voice and speed.
  - Renders about 15 ms per character on an M4 Pro and cuts off past about 450 characters.
- **US-020:** Streaming speech while Claude is still writing, using the `MessageDisplay` hook, if its payload supports it.
- **US-021:** Clipboard or selection "read this to me" hotkey.
- **US-022:** Auto-ducking or pausing TTS while Wispr Flow is dictating, to avoid feedback. *Implemented* as a pause while any app uses the microphone, which resumes from the interrupted sentence.
- **US-023:** Distribute as a Claude Code plugin through a marketplace repo, plus a compiled `mouthpiece` binary (Homebrew tap or GitHub release). See §4.4.
  - The plugin bundles hooks, commands (`/mouthpiece:mode`, …), and `mp-hook`.
  - `SessionStart` detects a missing binary and prints the install command.
  - API keys come from plugin user-config options or `mouthpiece auth` (Keychain).
  - Test with `claude --plugin-dir`, then with a real marketplace install on a clean machine.

### Phase 5: Reply inbox (2026-10-18; design in §13; US-024 to US-026 implemented)

#### US-024: Reply routes on speak events
**Description:** As a user, I want each response to remember where it came from, so a reply can go back to that exact terminal.

*Implemented 2026-10-18, Orca only. Spec: `docs/superpowers/specs/2026-10-18-reply-inbox-engine-design.md`.*

**Acceptance Criteria:**
- [x] `SpeakEvent.reply?: { via: "orca"; target: string; agent: string }`, added in `contracts.ts` and `docs/api.md` in the same commit. The `tmux` and `url` routes come later.
- [x] Validation:
  - [x] Orca handles must match `^term_[A-Za-z0-9-]{1,128}$`.
  - [ ] tmux targets must match `TMUX_TARGET` (later).
  - [ ] `url` must be loopback http (later).
  - [x] A bad or unknown route drops the field and the event is still spoken.
- [x] A `hook-kit` helper (`replyRoute`) reads `ORCA_TERMINAL_HANDLE`. The Claude Code and Codex adapters attach the route it returns. `TMUX_PANE` comes later, and so does Gemini (its screen hasn't been seen).
- [x] `bun run check` passes

#### US-025: Daemon inbox and reply endpoint
**Description:** As a user, I want the daemon to keep the latest response per conversation and send my reply back to it.

*Implemented 2026-10-18, Orca only (same spec).*

**Acceptance Criteria:**
- [x] `GET /v1/inbox` lists one entry per conversation, holding its latest response, and drops entries under FR-7's limits
- [x] `GET /v1/inbox/events` streams new and changed entries
- [x] `POST /v1/reply {id, text}` sends through the entry's stored route, under the delivery controls in §13. It returns:
  - `202 {status: "submitted" | "typed"}` when sent;
  - `409` when the session is busy, has a newer response than `id` (`newer`), already has a reply in flight, or couldn't be checked (`unverified`);
  - `410` when the entry is gone;
  - `413` when the text is over 4,000 characters;
  - `422` when the entry has no route;
  - `403` while `[reply] enabled` is false.
- [x] "submitted" needs proof: Orca's `--wait-submit` turn start, or that session's prompt-submit hook within 5 s. Without it the status is "typed". The text is never resent and Enter is never pressed again automatically. `POST /v1/reply/submit {id}` sends Enter alone.
  - Orca's own report waits on a real run of `orca terminal send` being recorded. Until then the hook confirms.
- [x] Lines are joined into one before sending
- [x] Before typing, the driver checks that the session is idle and its prompt is empty, and refuses if it can't tell
- [x] An Orca driver (`adapters/orca`) runs `orca terminal show`, `orca terminal read --screen` and `orca terminal send … --enter --wait-submit 5 --json` through an injected `exec`. `mouthpiece start` passes it to the daemon. A tmux driver comes later.
- [x] Tests (fake `exec`, injected clock) cover each failure:
  - Enter absorbed: no hook arrives, so the status is "typed";
  - multi-line input is joined;
  - text is left at the prompt, so the reply is refused;
  - mid-turn, so the reply is refused;
  - a newer response, so the reply is refused;
  - two replies at once, so the second is refused.
- [x] Alerts are never inbox entries. They attach to an entry without blocking replies; a permission menu is refused by the screen check.
- [x] Reply text never appears in logs
- [x] `mouthpiece inbox` and `mouthpiece reply <label|id> <text…>` work
- [x] Tests use fake `exec` and fake drivers; no real terminal is ever typed into
- [x] `bun run check` passes

#### US-026: Inbox panel in the menubar app
**Description:** As a user, I want a small window that shows each new response with a reply box, so I can answer a session without finding its terminal.

*Implemented 2026-10-18. Specs: `docs/superpowers/specs/2026-10-18-reply-inbox-panel-design.md` (behaviour) and `2026-10-18-inbox-panel-redesign-design.md` (the SwiftUI "Conversation" layout, native macOS look).*

**Acceptance Criteria:**
- [x] A floating panel that doesn't take focus. It pops up per `[reply] popup` (`away` by default: unless the session's terminal app is in front), and also opens from the menubar and a hotkey (⌃⌥O; it was ⌃⌥I, which window managers like Magnet use).
- [x] Each session is a tab (status dot, ✕ on hover). The selected tab shows its full response, with inline markdown, under a "label · agent · age" line. *Changed from the first version's rows with the spoken summary and "Show full".*
- [ ] The reply box previews the text as one line, exactly as it will be typed. *Changed: the box grows to 5 lines and ↩ adds a line; the daemon joins lines into one before typing.*
- [x] ⌘↩ sends the reply. The row shows the result: submitted, typed but not submitted (with a **Submit** button that sends Enter alone), busy, newer response, or no route.
- [x] The reply box is turned off, with the reason shown, for rows with no route; alerts are never rows (part 1)
- [x] Rows can be removed: a tab's ✕, ⌘⌫ in an empty reply box, **Clear all** in the panel's ··· menu, and `mouthpiece inbox --dismiss <id|label>` / `--clear` (`POST /v1/inbox/dismiss`). A session's next response brings it back.
- [x] ⌘1–⌘9 and ⌃⇥ switch tabs; ⌘V, ⌘C, ⌘A and ⌘Z work in the reply box (a hidden Edit menu), so dictation that pastes (Wispr Flow) works too
- [x] The menubar shows "✉N" while N sessions wait, and its items show their hotkeys
- [x] Built and tested only into a temp dir (Guardrail 6)

#### US-027: Reply from a notification (stretch)
**Description:** As a user, I want to answer from a macOS notification banner, like Messages.

**Acceptance Criteria:**
- [ ] A notification with a text-reply action posts to `POST /v1/reply`
- [ ] Verified working from the ad-hoc-signed helper bundle, or this story is dropped

## 6. Functional Requirements

- **FR-1:** The daemon must bind to `127.0.0.1` only and require a shared-secret token on every non-health endpoint.
- **FR-2:** Hook clients must never block Claude Code. They must be `async: true`, send with a ≤ 300 ms timeout, always exit 0, and print nothing to stdout.
- **FR-3:** Text cleaning must run before both summarization and verbatim speech.
- **FR-4:** **summary** mode must produce at most `summarizer.maxChars` characters of speech per response (default 700 since 2026-10-17; it was 350). **full** mode must speak all cleaned text, split into chunks under each provider's per-request limit.
- **FR-5:** Only one audio item may play at a time, system-wide.
- **FR-6:** An interrupt for conversation C (for example a `UserPromptSubmit` from Claude Code session C) must interrupt and flush only C's audio.
- **FR-13:** The core (`packages/core`, daemon, queue) must not import or reference anything Claude Code-specific. All source-specific behavior lives in adapters and source profiles (§8.3).
- **FR-7:** Every spoken item must keep its source text (full and summary) for replay, for 24 hours or the last 100 items, whichever is smaller.
- **FR-8:** Provider failure must fall back to the next provider in the configured chain, ending in macOS `say`, within 3 s.
- **FR-9:** API keys must be read from env vars or the macOS Keychain, never from plain-text config committed anywhere.
- **FR-10:** All characters sent to paid providers must be metered and checked against a monthly budget.
- **FR-11:** Config lives at `~/.config/mouthpiece/config.toml` and is hot-reloaded on change.
  - A file that fails to load is reported with a spoken notice and `configError` in `GET /v1/status`, and the previous config is kept (the defaults at startup).
  - The menubar's Settings menu writes changes into the file, keeping the rest of it as written.
- **FR-12:** The daemon runs as a `launchd` user agent (`mouthpiece install-agent`) and also in the foreground for development.

## 7. Non-Goals (v1)

- No speech-to-text. Wispr Flow already covers input.
- No voice *conversation* or agent: Mouthpiece speaks, it doesn't converse. *Since 2026-10-18:* typed (or dictated) replies from the inbox (§13, US-024 to US-026).
- No cross-platform support in v1. macOS only, though Linux shouldn't be precluded.
- No GUI beyond the optional menubar stretch goal. *Since 2026-10-18:* the inbox panel (§13, US-026).
- No reading of tool output, diffs, or file contents. Only assistant prose.
- No cloud hosting or multi-user anything. Single user, local only.
- No custom voice cloning workflow in v1 (providers support it; revisit later).

## 8. Technical Considerations

### 8.1 Proposed layout (Bun monorepo)

*The original proposal; `CLAUDE.md` § Layout has the current packages and adapters (it adds `hook-kit`, `client`, `hotkeys`, `summarizers`, `listen`, `adapters/tmux` and `adapters/orca`).*

```
mouthpiece/
├── packages/
│   ├── daemon/        # HTTP server, queue, pipeline, playback
│   ├── core/          # cleaning, chunking, summarizer, provider interface, config
│   ├── providers/     # inworld, deepgram, elevenlabs, openai, say, (kokoro)
│   └── cli/           # `mouthpiece` CLI
├── adapters/          # everything source-specific; core never imports these
│   ├── claude-code/   # mp-hook, install-hooks, slash commands, (plugin later)
│   ├── codex/
│   ├── gemini/
│   ├── file-tail/
│   └── (discord/)     # future: local gateway client + ConversationDriver
├── tasks/             # PRDs
└── docs/
```

### 8.2 Pipeline

| Stage | What it does |
|---|---|
| `ingest` | Normalize the event into the generic envelope (§8.3) |
| `filter` | Drop trivial or too-short text; apply mute and mode |
| `clean` | Markdown → speakable text, plus the source profile's extra rules |
| `summarize?` | Only in summary mode, only if the text is longer than the threshold, using the source profile's prompt |
| `chunk` | Split at sentence boundaries |
| `synthesize` | Stream from the provider (cache lookup first) |
| `enqueue` / `play` | Hand the audio to the queue and player |

### 8.3 Source-agnostic design

Claude Code is the first source, not a special one. **Everything source-specific lives at the edges.**

**Generic event envelope** (input to `POST /v1/speak`):

| Field | Meaning | Claude Code | Discord bot (example) |
|---|---|---|---|
| `source` | Which adapter sent it | `claude-code` | `discord` |
| `conversationId` | Unit for coalescing and interrupts | session id | channel or thread id |
| `label` | Spoken prefix when several sources are active | project name | "*Discord, alerts*" |
| `kind` | `response` \| `alert` \| `info` | Stop → `response`, Notification → `alert` | alert post → `alert` |
| `format` | `markdown` \| `plain` | `markdown` | `markdown` |

**Source profiles** (config, keyed by `source`) hold the per-source behavior:
- default mode (summary or full)
- the summarizer prompt (coding-oriented for Claude Code; "what happened, what do I need to do" for alerts)
- extra cleaning rules (Discord: `<@123>` mentions → names, `:emoji:` dropped)
- voice, priority, and mute settings

*2026-10-18:* two envelope fields let a source shape how it's heard, with no source-specific code in the core: `verbatim` (speak the text as given, never summarized; mute still applies) and `announce: "always" | "auto"` (speak the label every time, or only when several conversations are active). A source profile's `announce = "never" | "auto" | "always"` overrides the event. The first user is lambda-ai, which speaks its own Go-written headlines (spec `docs/superpowers/specs/2026-10-18-lambda-ai-speech-design.md`).

**Adapters run locally and pull.** A source on another machine, like a Discord bot hosted elsewhere, is handled by a small local adapter that connects *out* to Discord's gateway and forwards events to the loopback daemon. The daemon never opens an inbound port beyond `127.0.0.1`.

**Replying is the same seam as §12.** "Respond to the Discord bot" is a **ConversationDriver** that posts a message back to the channel. It's the same interface Claude Code would use via tmux. v1 ships no drivers, but `conversationId` and `source` on every queued item keep the reply target addressable later. *2026-10-18:* the reply inbox (§13) would add a `reply` route to the envelope, because `conversationId` alone doesn't name a terminal.

**Mouthpiece as a framework.** The long-term shape is a local voice layer that other tools build on, not a Claude Code add-on. The extension points:

| Extension point | Interface | v1 implementations |
|---|---|---|
| **Sources / adapters** | Generic envelope over `POST /v1/speak` and `/v1/interrupt` | Claude Code, CLI/pipe, Codex, Gemini; log tailers (`mouthpiece tail`, `[[follow]]`) incl. Margin; lambda-ai posts directly |
| **TTS providers** | `TtsProvider` | `say`, Kokoro (local), Inworld, ElevenLabs, Deepgram, OpenAI |
| **Summarizers** | `Summarizer`: `summarize(text, profile) → string` | `claude -p`, first-sentences fallback |
| **Source profiles** | Config: prompt, cleaning rules, mode, voice | Claude Code, default |
| **Conversation drivers** | `ConversationDriver` (§12); `ReplyDriver` (§13) | `TmuxDriver` (spike, `mouthpiece send`); `OrcaReplyDriver` (the reply inbox) |

**v1 framework commitments (cheap now, expensive to retrofit):**
- The HTTP API is versioned (`/v1`), documented in `docs/api.md`, and changed only additively within v1.
- Every interface above lives in `packages/core` with no source- or vendor-specific imports (FR-13). Built-in implementations use exactly the same interfaces a third party would.
- A small `@mouthpiece/client` TypeScript package (`speak()`, `interrupt()`, token discovery) is what our own adapters use. That way adapter code doubles as the example code for third parties.

**Not in v1:** loading third-party providers or adapters as runtime plugins, a plugin registry, or SDKs in other languages. Any language can already integrate over HTTP. Revisit once a second real consumer (e.g. the Discord bot) exists.

### 8.4 Audio playback

Easiest first: write mp3 to a temp file and run `afplay`. This adds latency, since playback waits for the whole file.

Better: stream PCM into a long-lived player process (`ffplay -nodisp -`, `sox play`, or a small Swift CoreAudio helper) so playback starts on the first chunk. Decide this in the US-002 spike.

**Decided and built (2026-10-17): `mouthpiece-player`,** a small Swift `AVAudioEngine` player in the helper app bundle. Plan: `docs/superpowers/plans/2026-10-17-gapless-player.md`.
- **Why:** `afplay` costs about 0.9 s per clip, and Kokoro pads each clip with about 0.65 s of silence. That made a break of about 1.5 s between every clip.
- **How:**
  - The player plays PCM clips back to back and reports when each has 0.3 s left, so the daemon sends the next one in time.
  - With a local model, the speaker renders ahead and starts only once the rest can keep up (G8).
  - `afplay` remains the fallback when the helper isn't built, for non-PCM clips, or when the player crashes, hangs or can't start.
  - The engine stops after 30 s idle.
- **Not done yet:** streaming a cloud provider's audio into the player as it arrives (US-005's original intent).

### 8.5 Latency budget (summary mode)

| Step | Target |
|---|---|
| Hook → daemon | ≈ 50 ms |
| Haiku summary via `claude -p` (default) | ≈ 1.5–3.5 s, including process cold start (verify in US-002) |
| Haiku summary via API (optional) | ≈ 500–900 ms |
| TTS time to first byte | ≈ 100–300 ms (Inworld); ≈ 0 for `say` |
| Player start | ≈ 50 ms |
| **Total** | **≈ 2–4 s** via `claude -p`, **≈ 1–1.3 s** via the API |

Measured (2026-10-17):
- `claude -p` summaries took 2–8 s, longer for complex replies.
- Kokoro renders about 15 ms per character, and speech starts once the start gate is satisfied (usually 1–1.5 s of rendering).
- Total from the end of a complex response to speech: about 5–10 s. G8 is accepted in exchange.
- A later option is to stream the summary and start on its first sentence. That arrives 0.9–1.4 s before the whole summary.

Full mode skips the summary call and is faster to first audio. If `claude -p` cold start dominates, options are:
- a warm, long-lived `claude -p` process using streaming JSON input
- the speech-TL;DR output style (Open Question 1)

### 8.6 Privacy

The full assistant text, which may include code context, file names, and secrets Claude echoed, goes to the summarizer and the TTS provider. Mitigations:

- Send only cleaned text, with code blocks removed.
- Redact anything that looks like a secret, using regexes for keys and tokens.
- A per-project `local_only = true` setting forces `say` or Kokoro.

### 8.7 Dependencies

- Bun ≥ 1.2
- `claude` CLI, already installed and logged in (default summarizer)
- `@anthropic-ai/sdk` (optional API-key summarizer)
- Provider SDKs, or plain `fetch` and WebSocket clients
- `afplay`, which is built in

## 9. Economics

Research done 2026-10-17 from official pricing pages; see Appendix A for sources and caveats.

**Usage model** (heavy day): 150 spoken responses/day.

| Scenario | Characters per response | Characters/day | Characters/month (30 days) |
|---|---|---|---|
| **A — summary** | ~400 | 60K | **1.8M** |
| **B — full** | ~2,000 | 300K | **9.0M** |

### 9.1 TTS cost per month

| Provider / model | Rate | A: summary (1.8M) | B: full (9M) | Notes |
|---|---|---|---|---|
| **Inworld TTS-2 Flash** | $15/1M (on-demand) | **$27** | $135 | 20 ms P90 time to first byte claimed; cheapest high-quality cloud option |
| Inworld TTS-2 | $25/1M | $45 | $225 | Higher-quality tier; instant voice cloning |
| **Deepgram Aura-2** | $30/1M | $54 | $270 | **$200 free credit** (≈ 3.7 months of A); 2,000-char request cap |
| OpenAI tts-1 / gpt-4o-mini-tts | $15/1M / ≈ $0.015/min | $27 / $27–34 | $135 / $135–169 | gpt-4o-mini-tts is steerable ("speak briskly") |
| **ElevenLabs Flash / v4 Turbo** | $40/1M (or Pro at $99 for 2.475M) | $72 | ≈ $360 | Best voices and cloning; plan credits expire monthly |
| ElevenLabs v4 / v3 | $80/1M | $144 | $720 | Premium expressiveness |
| Cartesia Sonic | $49 plan + $45/1M | ≈ $74 | ≈ $398 | Not competitive at this volume |
| macOS `say` / Kokoro (local) | $0 | $0 | $0 | Kokoro quality is surprisingly good on Apple Silicon |

### 9.2 Summarizer cost

**Default: `claude -p` on the Claude subscription costs $0 extra.**
- It counts toward the plan's usage window: about 150 small Haiku calls/day, roughly 150K input tokens/day.
- Watch whether this noticeably eats into the limits during heavy coding days.

**Optional API-key path:** Claude Haiku 5.5 at $0.10 / $0.50 per 1M input / output tokens.
- **Input:** 150/day × ~1,000 tokens (system prompt plus response) × 30 = 4.5M tokens × $0.10/1M = **$0.45**
- **Output:** 150/day × ~100 tokens × 30 = 450K tokens × $0.50/1M = **$0.23**
- **Total:** **≈ $0.70/month.**

Either way, the summarizer is negligible next to TTS, and it cuts TTS spend by about 5×.

### 9.3 Takeaways

1. **Summary mode is the main economic lever.** About $27–54/month vs $135–360/month for full. Summaries also make listening much more pleasant.
2. **Build on `say` ($0), then move to Inworld TTS-2 Flash** (≈ $27/month in summary mode) as the first paid provider. ElevenLabs stays the quality benchmark, and Deepgram's $200 credit is a free backup option if Inworld disappoints.
3. **Real usage is likely lower than these estimates.** Not every turn needs speaking: the triviality filter, mute, and replay come from cache. Re-estimate after two weeks of usage-meter data (US-016).

## 10. Success Metrics

- I use Mouthpiece in at least 80% of Claude Code sessions after 2 weeks (self-reported, plus a usage log).
- Median latency from response end to first audio, measured by the daemon:
  - **≤ 1.5 s** in full mode
  - **≤ 4 s** in summary mode
- Claude Code adds **0 ms** of perceived delay (hooks are async; verified in US-001).
- In a 20-sample review, at least 90% of summaries are good enough that I'd act the same as if I'd read the full text.
- Steady-state monthly cost is **≤ $50**.
- I can step away from the screen during multi-session work and know which session needs me, by ear alone.

## 11. Open Questions

1. **Summarizer vs an output-style "speech TL;DR":** should Claude itself end each response with a `<speak>…</speak>` or "TL;DR:" line that Mouthpiece extracts, instead of a separate Haiku call? It's free and has the full context, but it clutters the visual output and depends on Claude following the instruction. **Experiment both.**
2. **Default provider and voice:** decided by the US-002 bake-off.
3. **Feedback with Wispr Flow:** if I dictate while Mouthpiece is speaking through speakers, does Wispr pick up the TTS audio? Options:
   - Headphones only
   - Auto-pause when the mic is active (detectable via CoreAudio "device in use")
   - A hotkey
4. **Multi-session UX:** is a spoken project-name prefix enough, or should each project get its own voice? Or both?
5. **Interrupt semantics:** should a *new response* from the same session interrupt one that is currently playing, or wait?
6. **What about long silent stretches?** For example, speak "*still working…*" during long autonomous runs. Probably no: that's noise.
7. **Gemini hook payloads** need verification before US-014. Codex's documented `Stop` input includes `last_assistant_message`; smoke-test the installed Codex version and the command-hook configuration. How many other CLIs matter (Cursor agent, Aider, opencode)?
8. **Distribution:** v1 is clone + `./install.sh` (US-011). Should we later publish the plugin and a Homebrew tap (US-023), or is the install script enough? This affects config and credential UX.
9. **Remote and SSH sessions:** if Claude Code runs on a remote box, should the hook POST back through an SSH reverse tunnel? Out of scope for v1, but don't preclude it: the daemon port is configurable.

## 12. Future direction: conversation mode (v2 sketch, not in scope)

**Idea:** Mouthpiece becomes a two-way voice relay. You speak, and it sends your words into a Claude Code session. It speaks the reply, then listens again automatically. The result is a hands-free conversation with a coding agent.

**What carries over from v1:** cleaning, summaries, TTS providers, the audio queue, interrupt-on-new-prompt, and the usage meter. The output half is unchanged.

**What's new:**

| Piece | Options | Leaning |
|---|---|---|
| **Conversation driver** (send input back to a source; Claude Code shown here, Discord = post to channel) | (a) `tmux send-keys` into a pane running interactive `claude`; (b) Mouthpiece runs `claude -p` with streaming JSON input/output, resuming the same session id; (c) focus the terminal and let Wispr type | **(a) first.** It keeps the terminal UI and reuses the Stop hook. (b) is the clean long-term route. |
| **Speech input** | Wispr Flow (hotkey-driven; no known API, *verify*), or Mouthpiece's own STT: Deepgram streaming, or local Whisper/Parakeet | Own STT for hands-free mode. Wispr stays for normal typing. |
| **Turn-taking** | Detect end of speech (silence detection), a "send it" keyword, or push-to-talk | Push-to-talk first, auto-listen later |
| **Barge-in** | Stop playback as soon as you start talking | Needs headphones or echo cancellation |
| **Permission prompts** | Speak "*Allow Bash: npm test?*" and accept a spoken yes/no | Only with driver (b), or a tmux keystroke |

**v1 implications (cheap to do now):**
- Treat input as a pluggable **ConversationDriver** interface alongside `TtsProvider`, even if v1 only has a no-op driver:
  ```ts
  { readonly source: string; send(conversationId, text): Promise<void> }  // one driver per source
  ```
- Keep the conversation registry in the daemon, not in hooks. It maps `source` + `conversationId` → label, tmux pane or Discord channel, and transcript.
- The "no STT" non-goal applies to v1 only.

**Open questions:**
- Does Wispr Flow expose any trigger or output API?
- Would conversation mode run alongside the terminal UI, or replace it?
- How do we handle long autonomous runs mid-conversation, e.g. "I'll tell you when I'm done"?

## 13. Reply inbox (proposed and implemented 2026-10-18)

> **As built** (specs `docs/superpowers/specs/2026-10-18-reply-inbox-engine-design.md`, `…-reply-inbox-panel-design.md`, `…-inbox-panel-redesign-design.md`). This section is the original proposal; where they differ, the specs win:
> - **Orca only.** The tmux and `url` routes are later. The route is `{ via: "orca", target, agent }`. A headless `claude -p` run attaches none, and a terminal belongs to the latest session that reported from it.
> - **States** are `waiting`, `busy`, `sending` and `typed`. Entries leave under the history limits, by a newer response, or by being dismissed (`POST /v1/inbox/dismiss`). Alerts attach to an entry without blocking replies; a permission menu is refused by the screen check.
> - **The checks** read `orca terminal show` (same agent, writable) and `orca terminal read --screen` (per-agent rules for idle and an empty prompt). Anything unrecognized is refused. There is no `check_prompt = false` override. Orca's composer draft is ignored: it isn't the terminal's prompt.
> - **"Submitted"** comes from Orca's receipt (`turn_started`) or the session's prompt-submit hook within `confirmMs`.
> - **The panel** is SwiftUI in the "Conversation" layout, with a native look: tabs, the full response, and a growing reply box. It opens on ⌃⌥O; ⌃⌥I clashed with window managers. `[reply] popup` is `away` by default.

**Idea:** the Mac app shows each response as soon as the daemon queues it, in an inbox panel with a reply box. A reply you type there goes back into the session the response came from, as if you had typed it at that session's prompt. It is the text-first half of §12. Wispr Flow already types into any focused text field, so you can dictate into the reply box from day one.

**Is it possible? Yes, for sessions in Orca or tmux, for any agent CLI.** Findings, 2026-10-18 (Claude Code 2.1.302, Orca 1.4.224):

| Where the session runs | How a reply gets back | How Mouthpiece learns the target | Verdict |
|---|---|---|---|
| **Orca** (the user's terminal) | `orca terminal send --terminal <handle> --text <reply> --enter --wait-submit <s> --json`. Its JSON result reports whether the input was accepted, whether the prompt was submitted, and whether a turn started. `orca terminal wait --for tui-idle` exists too. | `ORCA_TERMINAL_HANDLE` is in the environment the agent passes to its hooks | **Chosen first.** The CLI exists in the app bundle (`/Applications/Orca.app/Contents/Resources/bin/orca`). Not tried yet: verify that a hook sees the handle and that `send` is accepted. |
| **tmux** | `TmuxDriver` (`adapters/tmux`, `mouthpiece send --tmux`): `send-keys -l` and then Enter | `TMUX_PANE`, inherited by hooks | **Chosen with Orca.** Already built. It joins lines into one and can't confirm submission. Hooks inheriting `TMUX_PANE` isn't a documented contract (*verify*). |
| Claude Code **channels** (research preview) | An MCP server declares `claude/channel` and sends `notifications/claude/channel`. An idle session starts a turn, and a busy one queues the event. | The server gets `CLAUDE_CODE_SESSION_ID` (stale after `/clear`) | **Later, as an option.** It works in any terminal, but only for Claude Code. The session must start with `--dangerously-load-development-channels server:<name>` (a warning dialog), and the model sees a `<channel>` event, not your prompt. |
| Claude Code **cross-session socket** (`CLAUDE_CODE_MESSAGING_SOCKET`) | Post a message into the session | Hook env | **Not chosen.** The wire format isn't documented, and messages are framed as coming from another session, not from you. |
| `claude -p --resume <id>` | Runs a separate headless turn | `session_id` | **Not chosen.** It doesn't reach the open terminal UI, and the two processes interleave one transcript. |
| Remote Control | Anthropic's relay into the same session | — | **Not chosen.** There is no local API, and it needs claude.ai login. |
| iTerm2, Terminal.app, Ghostty | AppleScript `write text` or synthetic keystrokes | `ITERM_SESSION_ID`; nothing for Ghostty | **Not chosen.** It needs Automation or Accessibility permission, and keystrokes go to whatever has focus. |
| **Margin** | Reply in Margin's page. The inbox shows "Open in Margin" | — | A user comment needs the page's private token (Margin internals, §8.3 note). |
| **Any source with its own loopback server** (e.g. lambda-ai) | The daemon POSTs `{conversationId, text}` to a URL the source gave | The event's `reply` | Generic. lambda-ai would need a small endpoint that posts into its Discord thread. |

Codex, Gemini and opencode sessions in Orca or tmux use the same terminal routes, with no extra work.

**Design sketch:**
- **Envelope (additive):**
  - A `SpeakEvent` can carry an optional `reply`: `{ via: "orca" | "tmux" | "url", target: string }`.
  - Hook adapters fill it in from the environment through a `hook-kit` helper that checks Orca first, then tmux.
  - Each `via` has its own target rule, and `url` must be loopback http. An unknown `via` drops the field; it doesn't reject the event.
  - `orca` and `tmux` are terminal hosts, not sources, so FR-13 holds. Their drivers live in `adapters/`. `mouthpiece start` passes them to the daemon, as it already does for `[[follow]]`, because the daemon may not depend on adapters. The `url` driver is generic and lives in the daemon.
- **Inbox (daemon, in memory):**
  - One entry per conversation, holding its latest response: id, source, label, time, full text, spoken summary, reply route and state.
  - **States:**
    - **waiting:** a `response` arrived.
    - **busy:** a prompt-submit interrupt arrived, or a reply was sent.
    - **closed:** the conversation aged out under FR-7's limits.
  - Alerts such as permission prompts are listed with replies turned off ("answer in the terminal"). Typed text would pick a menu option.
  - Nothing is written to disk (§8.6).
- **API (additive):**
  - `GET /v1/inbox` returns the entries.
  - `GET /v1/inbox/events` is a server-sent event stream, so the app hears about new messages at once instead of polling.
  - `POST /v1/reply {id, text}` returns:
    - `202 {status: "submitted" | "typed"}`, where "typed" means the text is at the prompt but its submission wasn't confirmed;
    - `409` when the session is busy, the reply is stale, or the session couldn't be checked;
    - `410` when the entry is gone;
    - `413` when the text is too long;
    - `422` when there's no route.

    The delivery controls below give the details.
  - `POST /v1/reply/submit {id}` sends Enter alone, for a reply whose status is "typed".
  - A reply names an inbox entry, and the route is the one stored with that entry, never one taken from the request. So the endpoint can't be aimed at an arbitrary terminal.
  - The CLI gets `mouthpiece inbox` and `mouthpiece reply <label|id> <text…>`.
- **App:**
  - `MouthpieceHelper`, the existing AppKit menubar app, gets an Inbox panel. It floats and doesn't take focus, so it doesn't pull you out of what you're typing.
  - It opens when a new response arrives (`[reply] popup`, on by default) or from the menubar or a hotkey.
  - **Each row shows:**
    - the label and how long ago it arrived;
    - the spoken summary, which expands to the full markdown;
    - a reply field that sends on ⌘↩.

    The field is turned off, with the reason shown, when there's no route or the session is busy.
  - *Stretch:* a macOS notification with a text-reply action (`UNTextInputNotificationAction`), like Messages. *Verify* that it works from the ad-hoc-signed bundle.
- **Safety:**
  - Replies are off until `[reply] enabled = true`. `POST /v1/reply` is the first endpoint that can make an agent act.
  - Reply text is never logged. Each delivery logs only the source, label, route and result.
  - A sent reply fires that session's prompt-submit hook, which already interrupts its speech (US-008). So a reply also stops any speech still playing for that session.
- **Delivery controls:**
  - **What can go wrong:** text typed into a terminal is input, not a message.
    - A reply can sit typed but never submitted, while you think it was sent.
    - It can be cut short at a newline, or merged with text that was already at the prompt.
    - It can arrive in the middle of a turn.

    In each case the agent waits forever, or acts on an instruction you didn't write. The second is worse: "fix the tests" on line 1 is submitted without "but don't touch the fixtures" on line 2, by an agent that can run tools. Every control below either prevents a case or reports it. None of them guesses.
  1. **Submission is confirmed, never assumed:**
     - **Orca:** uses its own text-plus-Enter send (`--enter`), which is built for agent prompts.
     - **tmux:** sends the text and the Enter as two separate inputs, with a short settle in between (150 ms, from an injected clock). That way an Enter that arrives too soon isn't absorbed into a paste.
     - A reply counts as **submitted** only when Orca's `--wait-submit` reports that a turn started, or when that session's prompt-submit hook arrives within 5 s. Both Claude Code and Codex send that hook.
     - Otherwise the result is **typed, not submitted**. The panel says so, and offers a **Submit** button that sends Enter alone.
     - Mouthpiece never resends the text, and never presses Enter again on its own.
  2. **One line, shown before it's sent:**
     - Both drivers join the lines of a reply into one, separated by spaces. The reply box previews the text exactly as it will be typed.
     - A reply over 4,000 characters is refused (`413`), not cut.
     - Multi-line delivery stays off until Orca is shown to keep newlines as a paste.
  3. **Only into a session waiting at an empty prompt:**
     - The entry must be **waiting**: its latest event is a response, and no prompt-submit has arrived since. If you type at the terminal yourself, the entry turns **busy** and the reply is refused (`409`).
     - The reply must name the entry's latest response id. If a newer response arrived while you were typing, it's refused (`409 newer`), so you read it first.
     - Only one reply per conversation is in flight at a time.
     - Just before typing, the driver checks that the session is idle (Orca: `orca terminal wait --for tui-idle`) and that its prompt line is empty (Orca: `orca terminal read`; tmux: `capture-pane`). *Verify* that both checks can be read reliably for Claude Code's and Codex's prompt.

       If a check can't be done, the reply is refused rather than sent blind (`409 unverified`). A per-route `[reply] check_prompt = false` can turn the empty-prompt check off, at your own risk.

**Open questions:**
- ~~Should the panel pop up for every response, or only when you're away?~~ *Decided:* `[reply] popup = "away" | "always" | "never"`, `away` by default.
- Multi-line replies: the reply box takes several lines, and the daemon joins them into one before typing. *Still to verify:* whether `orca terminal send` keeps newlines as a paste, which would allow real multi-line replies.
- Is a Claude Code channel worth adding for sessions outside Orca and tmux, given the launch flag and the `<channel>` framing?
- Should a Margin row deep-link to the thread in its page?

## Appendix A: TTS provider research notes (2026-10-17)

| Provider | Models | Latency claim | Streaming | Formats | Free tier | Limits | Source |
|---|---|---|---|---|---|---|---|
| ElevenLabs | `eleven_flash_v2_5` (~75 ms), `eleven_v4_turbo` (~100 ms), `eleven_v4`, `eleven_v3_conversational` | 75–280 ms | HTTP stream + `stream-input` WebSocket | mp3, pcm 8–48 kHz, opus, μ-law | 10–20K chars/month | Concurrency: Starter 6/3, Creator 10/5, Pro 20/10 | elevenlabs.io/pricing/api, elevenlabs.io/docs/models |
| Inworld | `inworld-tts-2`, `inworld-tts-2-flash` (TTS-1.x retired 2026-06-15) | 20 ms (Flash) / 100 ms (TTS-2) P90 server-side; docs conflict | HTTP stream, WebSocket, batch | mp3, pcm, wav, opus, μ-law | Up to 70 min on on-demand | 5 concurrent on-demand | inworld.ai/pricing, docs.inworld.ai/tts |
| Deepgram | Aura-2 (`aura-2-<voice>-en`), Aura-1 | Sub-200 ms | REST chunked + WebSocket (linear16/μ-law only) | mp3, linear16, opus, flac, aac | **$200 credit**, no card | 2,000 chars/request; 45 concurrent | deepgram.com/pricing, developers.deepgram.com/docs/text-to-speech |
| OpenAI | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` | Not published | Chunked HTTP | mp3, opus, aac, flac, wav, pcm 24 kHz | — | — | developers.openai.com/api/docs/pricing |
| Cartesia | `sonic-3.6` (older snapshots sunset 2026-10-20) | Sub-90 ms (secondary sources) | WebSocket | pcm_f32le, … | 20K credits | 2–15 concurrent | cartesia.ai/pricing |
| macOS `say` | System and Siri voices | ≈ 0 | n/a | aiff / m4a via `-o` | Free | — | built in |
| Kokoro-82M | Open weights (likely Apache-2.0, *verify*) | Local; Core ML port claims 12–79× realtime | n/a | wav | Free | — | huggingface.co/mattmireles/kokoro-coreml |

**Unverified or flagged:**
- ElevenLabs: the per-character overage rate, and which concurrency bucket v4 falls in.
- Inworld: whether the plan fee is credited toward usage.
- Deepgram: Growth-tier commitment terms.
- OpenAI: the per-minute figure is a community estimate.
- Kokoro: license unconfirmed.

## Appendix B: Claude Code hooks references

- Hooks reference: https://code.claude.com/docs/en/hooks
- Settings: https://code.claude.com/docs/en/settings
- Plugins and components: https://code.claude.com/docs/en/plugins/components
- Headless / `claude -p`: https://code.claude.com/docs/en/headless
- Output styles: https://code.claude.com/docs/en/output-styles
- Agent SDK hooks: https://code.claude.com/docs/en/agent-sdk/hooks

## Appendix C: Codex integration references

- Hooks: https://learn.chatgpt.com/docs/hooks
- Advanced configuration: https://learn.chatgpt.com/docs/config-file/config-advanced
- Skills and MCP plugin architecture: https://developers.openai.com/plugins/concepts/plugins
- Skills: https://developers.openai.com/plugins/concepts/skills

**Unverified** (resolve in US-001):
- `http` hook request body
- `MessageDisplay` payload fields
- The full common-field list on hook input
