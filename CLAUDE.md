# Mouthpiece

Mouthpiece is a local, source-agnostic voice layer. A loopback daemon accepts text events, cleans and (optionally) summarizes them, synthesizes speech with a pluggable TTS provider, and plays them through one non-overlapping queue. Claude Code is the first source adapter; anything that can POST JSON is a source.

- Spec: `docs/PRD.md`. It is the source of truth for behavior; cite user stories (US-xxx) and FRs in commits and PRs.
- Plans: `docs/superpowers/plans/`. Start with the roadmap, then the current phase's plan.
- HTTP API contract: `docs/api.md`.

## Environment

- macOS on Apple Silicon. **Bun must be the native arm64 build, ≥ 1.2.**
  - Check: `bun -e 'console.log(process.arch, Bun.version)'` must print `arm64`.
  - An x64 Bun runs under Rosetta and prints "CPU lacks AVX support" warnings. Fix it before doing anything else.
- Audio uses the built-in `say` and `afplay`.
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

## Layout

```
packages/core       contracts (types), envelope validation, cleaning, chunking, config, home/token
packages/providers  TtsProvider implementations (say, inworld, …) + fallback chain
packages/daemon     HTTP server, speech queue, speaker pipeline, player
packages/summarizers  Summarizer backends (claude -p) + first-sentence fallback
packages/hotkeys    global hotkeys: Swift helper + TypeScript supervisor
packages/client     @mouthpiece/client: speak/interrupt/stop/skip/health/mode/replay/usage over HTTP
packages/cli        `mouthpiece` CLI
adapters/*          everything source-specific (claude-code, codex, …)
```

Dependency direction: `core` ← `providers`, `summarizers`, `hotkeys`, `client` ← `daemon` ← `cli`. `daemon` may depend on `providers`, `summarizers`, and `hotkeys`; `cli` may also depend on `hotkeys`. `adapters/*` may depend only on `core` and `client`.

## Conventions

- **TypeScript:**
  - Strict mode, ESM, named exports only.
  - One responsibility per file. Tests sit next to the code as `*.test.ts`.
- **Source-agnostic core (FR-13):**
  - Nothing under `packages/` may mention Claude Code, Discord, or any other specific source.
  - Source-specific code lives in `adapters/`.
- **Changing contracts:**
  - The contracts are `packages/core/src/contracts.ts` and `docs/api.md`. Changes must be **additive** within `/v1`.
  - Update both files in the same commit.
  - Validation ignores unknown fields, for forward compatibility.
- **TDD:** write the failing test first.
  - Tests must not depend on wall-clock timing; inject `now()` and use fakes.
- **Commits:**
  - Small and conventional (`feat(core): …`, `fix(daemon): …`), each referencing the user story.
  - `bun run check` must pass before every commit.

## Guardrails (hard rules)

1. **Never touch the real user environment from code, tests, or agents:**
   - `~/.claude/settings.json`
   - `~/Library/LaunchAgents`
   - the macOS Keychain
   - the real `~/.mouthpiece`

   Tests set `MOUTHPIECE_HOME` and `MOUTHPIECE_CONFIG` to a temp dir. Claude Code hooks are tried with `claude --settings <file-or-json>` and never by editing user settings.
2. **No audio and no paid API calls in automated tests.**
   - Use `FakeProvider` / `FakePlayer`.
   - Live tests (real `say` playback, Inworld) only run when `MOUTHPIECE_LIVE_TESTS=1`.
3. **Hook scripts** never write to stdout, always exit 0, and give up after 300 ms. If they block Claude Code, that's a bug.
4. **The daemon binds to `127.0.0.1` only.** Every endpoint except `GET /v1/health` requires `Authorization: Bearer <token>`.
5. **Summarizer child processes** (`claude -p`) always run with `MOUTHPIECE_CHILD=1` in their environment. Hooks exit immediately when it is set.
6. **Never run `install.sh`, `uninstall.sh`, `launchctl`, `security`, or `mouthpiece install-*`/`uninstall-*`/`auth` against the real system.** Use `MOUTHPIECE_DRY_RUN=1` with a temp `HOME`, and inject `exec` fakes.
