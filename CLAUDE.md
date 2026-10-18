# Mouthpiece

Mouthpiece is a local, source-agnostic voice layer. A loopback daemon accepts text events, cleans and (optionally) summarizes them, synthesizes speech with a pluggable TTS provider, and plays them through one non-overlapping queue. Claude Code is the first source adapter; anything that can POST JSON is a source.

- Spec: `docs/PRD.md`. It is the source of truth for behavior; cite user stories (US-xxx) and FRs in commits and PRs.
- Plans: `docs/superpowers/plans/`. Start with the roadmap, then the current phase's plan.
- HTTP API contract: `docs/api.md`.

## Environment

- macOS on Apple Silicon. **Bun must be the native arm64 build, ≥ 1.2.**
  - Check: `bun -e 'console.log(process.arch, Bun.version)'` must print `arm64`.
  - An x64 Bun runs under Rosetta and prints "CPU lacks AVX support" warnings. Fix it before doing anything else.
- **Voices:** macOS `say`, the local Kokoro model (`kokoro-js` in a child process, installed by `mouthpiece kokoro install` into `~/.mouthpiece/kokoro`), or cloud providers.
- **Playback:** through `mouthpiece-player` (Swift, `AVAudioEngine`, gap-free) when the helper app is built, else `afplay`.
- Cloud TTS keys come from env vars, e.g. `INWORLD_API_KEY`. Never put keys in files.

## Commands

| Task | Command |
|---|---|
| Install deps | `bun install` |
| All tests | `bun test` |
| One file | `bun test packages/core/src/clean.test.ts` |
| Typecheck | `bun run typecheck` |
| Lint / format | `bun run lint`, `bun run lint:fix` |
| **Everything (run before every commit)** | `bun run check` |
| Daemon (foreground, isolated) | `MOUTHPIECE_HOME=$(mktemp -d) bun run daemon` |
| CLI | `bun run mouthpiece -- say "hello"` |
| Full helper build (temp dir, signs, never launches) | `MOUTHPIECE_HELPER_BUILD=1 bun test packages/hotkeys/src/build.test.ts` |

## Layout

```
packages/core       contracts (types), envelope validation, cleaning, chunking, config (+ setTomlValue line editor), WAV helpers (readWavPcm, trimWavSilence), home/token
packages/providers  TtsProvider implementations (say, kokoro, inworld, elevenlabs, deepgram, openai), voice map, fallback chain
packages/daemon     HTTP server, speech queue (pause/resume by reason), speaker pipeline (render-ahead + start gate), stream player (mouthpiece-player) with afplay fallback, settings (GET/POST /v1/settings writes config.toml), usage metering, quota gate, status
packages/summarizers  Summarizer backends (claude -p; prompt sized to the reply: key results first, the user's to-dos and questions last; trimmed from the middle) + first-sentence fallback
packages/hotkeys    helper app bundle: MouthpieceHelper (src/helper/*.swift: global hotkeys, menubar, mic watcher, reply inbox panel) and mouthpiece-player (gap-free audio): Swift sources + TypeScript build/args/supervisor
packages/client     @mouthpiece/client: speak/interrupt/stop/skip/health/mode/replay/usage/voices/status/pause/resume/settings over HTTP
packages/hook-kit   @mouthpiece/hook-kit: silent hook runtime (runHook, HookContext, labelFromCwd, approvalText) shared by hook adapters
packages/cli        `mouthpiece` CLI
packages/listen     on-device speech-to-text prototype (conversation-mode spike; standalone, not wired in)
adapters/claude-code  Claude Code hooks
adapters/codex      Codex CLI hooks
adapters/gemini     Gemini CLI hooks
adapters/file-tail  session-log tailers for tools without hooks (`mouthpiece tail`, `[[follow]]`), including Margin review logs
adapters/tmux       TmuxDriver (ConversationDriver over `tmux send-keys`; `mouthpiece send`)
adapters/orca       OrcaReplyDriver: types replies into Orca terminals (`mouthpiece reply`), with per-agent screen rules
```

Dependency direction: `core` ← `providers`, `summarizers`, `hotkeys`, `client` ← `daemon` ← `cli`. `daemon` may depend on `providers`, `summarizers`, and `hotkeys`; `cli` may also depend on `providers`, `hotkeys`, `adapters/file-tail`, `adapters/tmux`, and `adapters/orca`. `packages/listen` is a standalone prototype: it depends only on `core`, and nothing depends on it. `hook-kit` may depend only on `core` and `client`. `adapters/*` may depend only on `core`, `client`, and `hook-kit`.

## Conventions

- **TypeScript:**
  - Strict mode, ESM, named exports only.
  - One responsibility per file. Tests sit next to the code as `*.test.ts`.
- **Source-agnostic core (FR-13):**
  - Nothing under `packages/` may mention Claude Code, Discord, or any other specific source.
  - Source-specific code lives in `adapters/`.
- **Changing contracts:**
  - The HTTP contract is `docs/api.md` plus its request and response types in `packages/core/src/contracts.ts`. Changes to it must be **additive** within `/v1`. Update both files in the same commit.
  - Validation ignores unknown fields, for forward compatibility.
  - Code-only interfaces in `contracts.ts` (`TtsProvider`, `Player`, `ChunkHint`, `Summarizer`) have no consumers outside this repo. They may change, with every implementation updated in the same commit.
- **Speech never pauses once it starts** (the user's rule, 2026-10-17). When starting sooner would risk a pause mid-response, start later. Examples: the speaker's start gate (`packages/daemon/src/start-gate.ts`), and Kokoro's chunking with and without the gap-free player.
- **TDD:** write the failing test first.
  - Tests must not depend on wall-clock timing; inject `now()` and use fakes.
- **Commits:**
  - Small and conventional (`feat(core): …`, `fix(daemon): …`), each referencing the user story.
  - `bun run check` must pass before every commit.

## Guardrails (hard rules)

1. **Never touch the real user environment from code, tests, or agents:**
   - `~/.claude/settings.json`
   - `~/.codex` (`hooks.json`, `config.toml`, sessions) and `~/.gemini` (`settings.json`, chats)
   - Margin's state (`~/.cache/margin`) and any real `.margin/` review log (tests set `MARGIN_STATE_DIR`)
   - `~/Library/LaunchAgents`
   - the macOS Keychain
   - the real `~/.mouthpiece`

   Tests set `MOUTHPIECE_HOME` and `MOUTHPIECE_CONFIG` (and `MOUTHPIECE_CODEX_HOOKS` / `MOUTHPIECE_GEMINI_SETTINGS` for hook installs) to a temp dir. Claude Code hooks are tried with `claude --settings <file-or-json>` and never by editing user settings.
2. **No audio and no paid API calls in automated tests.**
   - Use `FakeProvider`, `FakePlayer` and `FakePlayerProcess`.
   - The Swift player's tests run it only with `--self-test` or `--self-test-idle`, which render offline into memory. Never run `mouthpiece-player` without one of them in a test or an agent.
   - The helper's inbox logic is tested only through `mouthpiece-helper --self-test-inbox`, which needs no daemon and opens no window. Never launch the helper otherwise in a test or an agent.
   - Live tests (real `say` playback, Inworld) only run when `MOUTHPIECE_LIVE_TESTS=1`.
3. **Hook scripts** run through `@mouthpiece/hook-kit` `runHook()`: they never write to stdout or stderr, always exit 0, and give up after 300 ms. If they block the host tool, that's a bug (Gemini CLI retries the turn on any output or non-zero exit).
4. **The daemon binds to `127.0.0.1` only.** Every endpoint except `GET /v1/health` requires `Authorization: Bearer <token>`.
5. **Summarizer child processes** (`claude -p`) always run with `MOUTHPIECE_CHILD=1` in their environment. Hooks exit immediately when it is set.
6. **Never run these against the real system:**
   - `install.sh`, `uninstall.sh`, `launchctl` or `security`;
   - `mouthpiece install-*`, `uninstall-*`, `auth`, `daemon start|stop|restart`, `build-helper` or `kokoro install|uninstall`.
   - `orca terminal send` against a real terminal. Tests inject `exec`; replies go only through `mouthpiece reply`, run by the user.

   Use `MOUTHPIECE_DRY_RUN=1` with a temp `HOME`, inject `exec` fakes, and build the helper only into a temp dir. When the user needs one of these run, give them the command (they can type `! <command>`).
