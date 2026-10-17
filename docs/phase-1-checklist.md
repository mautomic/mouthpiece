# Phase 1 manual checklist

Use the real default home (`~/.mouthpiece`) here, so hooks launched by Claude Code can find the token.

- [ ] `bun run daemon` starts and logs `listening`; `bun run mouthpiece -- status` shows provider `say`.
- [ ] `bun run mouthpiece -- say "Hello from Mouthpiece. This is the second sentence."` is audible with no gap between sentences.
- [ ] `echo "**Bold** and a [link](https://x.com)" | bun run mouthpiece -- say` reads "Bold and a link".
- [ ] Claude Code: in another project run `claude --settings "$(bun ~/code/projects/mouthpiece/adapters/claude-code/src/dev-settings.ts)"`, ask a question → the response is spoken; the prompt is immediately interactive (no added delay).
- [ ] Type the next prompt while it is speaking → speech stops at once (US-008).
- [ ] Two Claude Code sessions in different projects → no overlap; the project name is spoken once both are active.
- [ ] Stop the daemon, use Claude Code → no errors or delay in Claude Code.
- [ ] Bake-off: `INWORLD_API_KEY=… bun scripts/bakeoff.ts Samantha Ava` → listen to `bakeoff/*`, pick the default voice, and record the ranking and latencies in docs/PRD.md (US-002).
- [ ] Set `~/.config/mouthpiece/config.toml` to `[provider]\nchain = ["inworld", "say"]`, restart the daemon with `INWORLD_API_KEY` set → `first_audio` latencyMs in the log ≤ 700 for a short response.
- [ ] Spike leftovers (Task 1): capture the Notification payload interactively and note in `docs/hook-payloads.md` whether async hooks add any delay.
