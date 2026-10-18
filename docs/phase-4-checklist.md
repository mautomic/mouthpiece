# Phase 4 manual checklist

Run these against the installed daemon (launchd owns port 7317). Re-run `./install.sh` first: it rebuilds the helper as `~/.mouthpiece/MouthpieceHelper.app` (hotkeys, menubar, mic pause) and restarts the daemon on the new code. `mouthpiece status` should then print JSON with `"version": "0.4.0"`.

## Kokoro local voice (US-019)

- [ ] Run `mouthpiece kokoro install`, or answer `y` to "Install the free local Kokoro voice (~500 MB)?" in `install.sh`.
  - It downloads about **500 MB in total**: about 400 MB of `kokoro-js` packages into `~/.mouthpiece/kokoro`, then the 92 MB model into `~/.mouthpiece/kokoro/hf`.
  - It ends by printing the warm-up timing (`load … ms, first phrase … ms`).
- [ ] `mouthpiece kokoro status` reports it as installed, with `kokoro-js 1.2.1` and a model cache of roughly 90 MB.
- [ ] Set `chain = ["kokoro", "say"]` under `[provider]` in `~/.config/mouthpiece/config.toml`. The reload is picked up without a restart (`config_reloaded` in `~/.mouthpiece/daemon.log`), and `mouthpiece status` shows `"provider": "kokoro"`.
- [ ] Listen to a few responses:
  - In `daemon.log`, the first one's `first_audio` latency is about 1.5 s; after that, speech is smooth.
  - There is no `kokoro_load_failed` or `provider_skipped` line.
- [ ] `mouthpiece voices --provider kokoro` lists 28 voices. Setting `[provider.kokoro] voice = "bm_george"` changes the voice.
- [ ] Setting `[provider.kokoro] speed = 1.5` makes Kokoro talk faster (0.5 to 2; 1 is normal). A value outside that range is rejected with a spoken config notice and `configError` in `mouthpiece status`.
- [ ] Missing Kokoro: `mouthpiece kokoro uninstall`. With `kokoro` still in the chain, speech continues in `say`, and the reload logs `provider_skipped` with the hint to run `mouthpiece kokoro install`. Reinstall it, or remove `kokoro` from the chain.

## Menubar (US-018)

- [ ] The Mouthpiece icon appears in the menubar.
  - On macOS 26, if it doesn't, check System Settings → Menu Bar and allow "MouthpieceHelper".
- [ ] The icon follows the state: a waveform when idle, a speaker while speaking, a pause symbol while paused. While items are queued, their number shows next to it.
- [ ] Each menu action works:
  - Stop, Skip, Replay, Replay full.
  - The Mode submenu: its checkmark follows `mouthpiece mode`.
  - Pause speech / Resume speech. `mouthpiece status` shows `"pauseReasons": ["user"]` while paused.
  - The bottom line shows `Mouthpiece 0.4.0 · <provider>`.
- [ ] `mouthpiece pause` and `mouthpiece resume` do the same as the menu items.
- [ ] Settings → Voice lists the Kokoro voices in four groups (American/British, female/male) with a checkmark on the current one. Choosing one says "Hi, I'm <name>." in that voice, and `[provider.kokoro] voice` in `~/.config/mouthpiece/config.toml` changes to it, with your comments and other settings untouched.
- [ ] Settings → Speed has a checkmark on the current speed. Choosing one says "This is how fast I talk now." at that speed and updates `speed` in the config file.
- [ ] With a broken config file (e.g. `[provider] chain = ["kokoro"]` on one line), choosing a voice changes nothing; `daemon.log` shows `POST /v1/settings failed: HTTP 409` from the helper.
- [ ] Daemon down: `mouthpiece daemon stop`. The menubar icon either disappears (launchd stops the helper with the daemon) or, within a few seconds, shows the "daemon unreachable" symbol (a waveform with a slash) without using CPU in Activity Monitor. Note which.
- [ ] `mouthpiece daemon start`: exactly one Mouthpiece icon is in the menubar (`pgrep -fl mouthpiece-helper` lists one process). `mouthpiece daemon restart` keeps it at one.

## Pause while dictating (US-022)

- [ ] Get Mouthpiece speaking a long response (e.g. `mouthpiece say --mode full --file README.md`), then start a Wispr Flow dictation.
  - Speech pauses immediately.
  - It resumes about 0.8 s after you stop dictating, from the sentence it was on (not from the start, and without skipping ahead).
- [ ] If it doesn't pause, check `daemon.log` for `mouthpiece-helper: mic watcher: …` at startup and `mic in use (…); pausing speech` / `mic idle; resuming speech` lines.
- [ ] Calls: Zoom keeps the mic open while muted, so speech stays paused for the whole call. If you don't want that, add its bundle ID:

  ```toml
  [micPause]
  ignoreBundleIds = ["us.zoom.xos"]
  ```

- [ ] To turn the feature off, set `[micPause] enabled = false`.
- [ ] Safety net: if the helper is killed while the mic is in use (`pkill mouthpiece-helper`), speech resumes at once and the supervisor restarts the helper. A pause that is never resumed expires after `micPause.maxPauseMs` (10 minutes by default).
- [ ] **Bluetooth headset caveat:** a Bluetooth mic may not be detected as in use, so dictating through AirPods may not pause speech. Note what you see.

## Conversation spike (PRD §12)

- [ ] Read `docs/spikes/conversation-mode.md`: driver and STT options, turn-taking, echo and barge-in, and the recommended v2 path.
- [ ] Optional:
  1. `brew install tmux`.
  2. `tmux new -s cc`, then run `claude` inside it.
  3. From another terminal, `mouthpiece send --tmux cc "hello"`. The prompt is typed into Claude Code and submitted.
  4. Without tmux installed, `mouthpiece send` exits 1 with `install tmux: brew install tmux`.
- [ ] Optional: build and try the on-device speech-to-text prototype as section 8 of the spike doc describes. It asks for microphone and speech-recognition permission the first time.
