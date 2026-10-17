# Phase 2 manual checklist

Stop any foreground `bun run daemon` first (launchd will own port 7317).

- [ ] `./install.sh` completes: links `mouthpiece`, builds hotkeys, installs hooks + launchd agent, and you hear "Mouthpiece is ready."
- [ ] `mouthpiece status` works from a new terminal; `launchctl print gui/$UID/dev.mouthpiece.daemon` shows it running.
- [ ] Plain `claude` (no --settings) in any project: responses are spoken as **summaries**; a question Claude asks you comes first.
- [ ] Summary latency: `grep summarized ~/.mouthpiece/daemon.log` shows ms ≲ 3000.
- [ ] ⌃⌥S stops speech · ⌃⌥N skips · ⌃⌥R replays · ⌃⌥M flips summary/full (check with `mouthpiece mode`).
- [ ] `mouthpiece replay --full` reads the whole last response.
- [ ] `mouthpiece mode off` → responses silent; trigger a permission prompt → you still hear "<project> needs your approval to use Bash."
- [ ] Capture the Notification payload: temporarily add a capture hook (see docs/hook-payloads.md) or check that the spoken alert names the tool; record the real `notification_type`/`message` shape in docs/hook-payloads.md.
- [ ] Edit `~/.config/mouthpiece/config.toml` (e.g. `[modes] default = "full"`) → takes effect without restart (`config_reloaded` in the log).
- [ ] `mouthpiece usage` shows rows (provider `say`, cost $0.00).
- [ ] Summary quality: `bun scripts/summary-eval.ts ~/.claude/projects/<some-project>/*.jsonl` → review summary-eval.md; ≥ 18/20 good (US-009).
- [ ] `./uninstall.sh` removes agent + hooks (Claude Code goes quiet); `./install.sh` again restores everything.
- [ ] Optional, when you have a key: `pbpaste | mouthpiece auth inworld`, set `chain = ["inworld", "say"]`, hear Inworld; `mouthpiece usage` shows chars and cost.
