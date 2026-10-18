# Phase 3 manual checklist

Run these against the installed daemon (launchd owns port 7317). If it was installed before Phase 3, re-run `./install.sh` first so the daemon restarts on the new code; `mouthpiece status` should report version `0.3.0`.

## Voices (US-015)

- [ ] `mouthpiece voices --provider say` lists the voices installed on your Mac, one `id  name  language` per line.
- [ ] `mouthpiece voices` lists every provider in your chain; a paid provider whose key is wrong shows `(error: …)` instead of failing the command.
- [ ] Per-project voice: add a mapping for one project's label (its directory name) to `~/.config/mouthpiece/config.toml`:

  ```toml
  [voices.say]
  web = "Ava (Premium)"
  ```

  The reload is picked up without a restart (`config_reloaded` in `~/.mouthpiece/daemon.log`). Responses from Claude Code in `web` and in another project now sound different.
- [ ] `mouthpiece say --voice Samantha "Explicit voice wins."` uses Samantha even in a mapped project.
- [ ] `mouthpiece say --voice JBFqnCBsd6RMkjVDRZzb "Unknown to say."` (an ElevenLabs id) is still spoken, in the system voice, and `say_voice_failed` appears in the log.

## Quotas (US-016)

- [ ] Quota warning with no paid key, using the free `say` (it is still counted):
  1. Temporarily add `[usage.quotas]` with `say = { chars = 200 }` to `config.toml`.
  2. Talk until you hear "Say has used 8x% of its monthly quota." (the notice is spoken once per level per billing cycle, and it survives daemon restarts).
  3. `mouthpiece usage` shows the `say` quota with `level: "warn"`, then `"exceeded"` once you pass 200. `say` is never blocked, so speech keeps working.
  4. Remove the setting.
- [ ] `mouthpiece usage` shows `summaries` (`calls`, `failures`, `medianMs`) after a few summarized responses.

## Codex CLI (US-014)

- [ ] `mouthpiece install-hooks --target codex` writes only `~/.codex/hooks.json` (check that `~/.codex/config.toml` is unchanged and that any hooks you already had are still there).
- [ ] In Codex, run `/hooks` and trust the Mouthpiece hooks.
- [ ] Ask Codex something: the final answer is spoken.
- [ ] Typing a new prompt while it speaks interrupts the speech.
- [ ] An approval request is spoken ("<project> needs your approval to use shell.").
- [ ] Without hooks: `mouthpiece uninstall-hooks --target codex`, then run `mouthpiece tail --format codex` in another terminal while using Codex. Final answers are spoken, nothing from before the tail started is read out, and Ctrl-C stops it.

## CLI (US-013)

- [ ] `mouthpiece say --file README.md --mode full` reads the whole README.
- [ ] `mouthpiece say --priority high --kind alert "Jumps the queue."` plays before queued responses.
- [ ] With the daemon stopped (`mouthpiece uninstall-agent`), `mouthpiece say "hi"` prints that the daemon is not reachable, and `mouthpiece say --fallback-say "hi"` speaks locally. Restore with `mouthpiece install-agent`.
- [ ] `mouthpiece` with no command prints usage that includes `install-hooks [--target …]`, `voices [--provider x]`, `tail --format …` and every `say` flag.

## Paid providers (optional, needs a key)

- [ ] `pbpaste | mouthpiece auth elevenlabs` (or `deepgram`, `openai`), then set `chain = ["elevenlabs", "say"]` in `[provider]`. Responses use the new voice.
- [ ] `mouthpiece usage` shows chars and cost for that provider. For ElevenLabs, add `[usage.quotas] elevenlabs = { chars = <your plan's limit> }` and check that the quota entry also shows `providerReported` from ElevenLabs.
- [ ] Break the key (`echo bad | mouthpiece auth elevenlabs`): speech falls back to `say` and `provider_fallback` appears in the log. Restore the real key.

## Gemini CLI (optional, if installed)

- [ ] `mouthpiece install-hooks --target gemini` merges into `~/.gemini/settings.json` and keeps your other settings.
- [ ] Responses are spoken, a new prompt interrupts, and a tool-permission prompt is spoken as an alert.
- [ ] Gemini never shows hook output and never retries a turn because of the hook.
