# Spike: conversation mode (PRD §12)

Status: spike, Phase 4 Track D, 2026-10-17. Nothing here is wired into the daemon or the installer.

**What was built:**

| Piece | Where | State |
|---|---|---|
| `TmuxDriver`, `isTmuxAvailable` | `adapters/tmux` (`@mouthpiece/adapter-tmux`) | Implements `ConversationDriver`. Unit-tested with a fake `exec`. |
| `mouthpiece send --tmux <target> [text…]` | `packages/cli/src/commands/send.ts` | Text from arguments or piped stdin. Unit-tested with a fake `exec`. |
| On-device speech-to-text prototype | `packages/listen` (`MouthpieceListen.swift`, `Info.plist`, `build.ts`) | Typechecks with `swiftc -typecheck`. An opt-in test builds and ad-hoc signs it into a temp dir. **Never run.** |

**What is unverified.** Read the rest of this document with this in mind:
- `tmux` is not installed on the build machine. No command in this spike has run against a real tmux server or a real Claude Code TUI.
- The listen prototype has never been launched. Nobody has seen a permission prompt, heard it transcribe, or measured its latency.
- All latency and cost numbers below are list prices or estimates, not measurements, unless they say "measured".

---

## 1. Goal

Conversation mode makes Mouthpiece a two-way voice relay:
1. You speak.
2. Mouthpiece turns the speech into text and sends it into a running agent session (Claude Code first).
3. The agent answers. The existing Stop hook and speech pipeline speak the answer (summary or full).
4. Mouthpiece listens again: on a key press first, automatically later.

The output half already exists (cleaning, summaries, providers, queue, barge-in on a new prompt, usage). The spike is about the input half: a **driver** that delivers text to a session, **speech-to-text**, and **turn-taking**.

## 2. Driver options

The contract is unchanged from Phase 1 (`packages/core/src/contracts.ts`):

```ts
interface ConversationDriver {
  readonly source: string;
  send(conversationId: string, text: string): Promise<void>;
}
```

### (a) tmux injection (implemented)

`TmuxDriver.send(target, text)` runs two commands:

```
tmux send-keys -t <target> -l -- <text>
tmux send-keys -t <target> Enter
```

For this driver the conversation id is a tmux target: `cc`, `cc:1.0`, `%3`.

**Choices made in the driver**, each covered by a test:
- **Target format.** The target must match `^[\w.:%$-]+$`. That allows sessions, `session:window.pane`, `%pane` and `$session` ids, and rejects spaces and shell or tmux syntax.
- **Single-line text.** Newlines become spaces, so one utterance is one prompt and one Enter. Empty text is rejected.
- **`-l --`.** `-l` types the text literally, so `Enter` or `C-c` inside the text are not read as key names. `--` stops text starting with `-` from being read as a flag. *(This deviates from the plan's argv: the plan had no `--`.)*
- **Trailing `;` is escaped as `\;`.** When tmux parses argv, an argument ending in `;` is a command separator. Without the escape, "do this;" would lose its semicolon. *(Not in the plan. Taken from the tmux argument parser's documented behavior; unverified against a real tmux.)*
- **Errors.** A non-zero exit throws with tmux's stderr. If typing fails, Enter is never sent.

**Why it's attractive:**
- You keep the full TUI.
- The Stop hook already speaks replies.
- It works for any agent that runs in a terminal (Claude Code, Codex, Gemini), unchanged.

**Risks found while building it** (all unverified, since tmux was not available):
1. **Typing into the wrong state.** If the agent is showing a permission prompt or a selection menu, typed text could pick an option. The daemon already sees the state through the hooks:
   - `UserPromptSubmit` means busy.
   - `Stop` means idle.
   - `Notification(permission_prompt)` means waiting on you.

   A v2 driver should only send when the conversation is idle. Otherwise it should queue the text or speak "Claude is waiting for permission".
2. **Paste detection.** Claude Code's TUI may treat a fast burst of characters as a paste. An `Enter` that arrives in the same burst could then become a newline instead of a submit. If that happens, add a short delay (about 50–150 ms) between the two `send-keys` calls. **Test this first by hand.**
3. **You typing at the same time.** Injected keys interleave with your own keystrokes. For voice use this is acceptable. Document it; don't engineer around it.
4. **Finding the pane.** A hook process inherits the agent's environment. When the agent runs inside tmux, that environment includes `TMUX_PANE` (for example `%3`), so the hook can report the pane. Mouthpiece then never asks you for a target. *(Very likely, but unverified.)*
5. **Security.** Anything that can call the driver can type into your terminal. `mouthpiece send` is fine, because you run it yourself. A daemon endpoint must:
   - require the bearer token (it already does)
   - only target panes that the hooks registered, never a target taken from the request body

### (b) Headless agent with structured I/O (the clean long-term route)

- **Claude Code.**
  - Run `claude -p --input-format stream-json --output-format stream-json` with `--resume <session-id>` (or `--session-id`), as a long-lived child of the daemon.
  - Each user turn is one JSON line on stdin. Replies, tool use and the final result come back as JSON events. No hook and no terminal scraping are needed.
  - Permission prompts can go through `--permission-prompt-tool` (an MCP tool that Mouthpiece serves), which makes spoken "Allow Bash: npm test?" plus a spoken yes/no possible (PRD §12). Or skip them with `--permission-mode`.
  - **Costs:** no TUI. Driving the same session from the TUI at the same time is unsafe (two writers on one session).
  - **To verify:** resume semantics while a TUI has the session open, and whether `stream-json` input stays open across turns without a restart.
- **Codex.**
  - `codex exec` handles one-shot turns, and `codex exec resume <session>` continues a session.
  - The IDE extensions use a JSON-RPC mode (`codex app-server`), which would be the structured equivalent of (b).
  - **To verify:** flags, stability, and how approvals surface.
- **Gemini CLI.**
  - `gemini -p` runs non-interactively. An ACP (Agent Client Protocol) mode exists for editor integrations.
  - **To verify:** session resume from the command line, and whether ACP is stable enough to drive.

### (c) Focus the terminal and let Wispr type

This needs no code: Wispr Flow already types into the focused window. It isn't hands-free (it needs a hotkey and focus), and Mouthpiece can't tell when you finished. It's the fallback for people who already use Wispr.

## 3. Speech-to-text options

| Option | Latency to final text | Cost | Privacy | Notes |
|---|---|---|---|---|
| **Apple `SFSpeechRecognizer`, on-device** (prototype here) | Partials stream as you talk. Final = silence endpoint (1.2 s) plus a short finalize. *Estimate, unmeasured.* | Free | Audio stays on the Mac (`requiresOnDeviceRecognition = true`) | Needs Dictation enabled for the language, so the on-device model is present. Weak on code words (identifiers, flags). Needs an app bundle with usage strings. |
| **Apple `SpeechAnalyzer` / `SpeechTranscriber`** (macOS 26) | Designed for low-latency long-form transcription. *Unmeasured.* | Free | On-device | This Mac runs macOS 26.5, so it is available. Model assets come through `AssetInventory`. Likely the better on-device engine. Swift-concurrency API. |
| **Wispr Flow** | Fast, and its formatting is excellent | Subscription you already have | Cloud (per Wispr's policy) | **No known API, trigger or output hook** (still to verify with Wispr). Usable only as driver (c). Its mic use already triggers the Phase 4 mic pause. |
| **Deepgram streaming** (Nova-3) | About 300 ms after you stop. Server-side endpointing and VAD included. | About $0.0077/min list price (verify), roughly $0.46 per hour of talking | Audio goes to Deepgram | A Deepgram key is already supported for TTS. Best turnkey streaming plus endpointing. Keyword boosting helps code words. |
| **Local Whisper / Parakeet** (whisper.cpp, MLX) | Batch per utterance after a local VAD. Estimated 0.2–1 s for a short utterance on an M4 Pro (`large-v3-turbo` or Parakeet TDT). *Unmeasured.* | Free | On-device | Best on-device accuracy for technical speech. A 0.6–1.6 GB model download (same install pattern as Kokoro). Not natively streaming, so you need your own VAD. |

**Recommendation:**
- Default to on-device Apple STT for the first version: free, private, and no download beyond Dictation.
- Prefer `SpeechAnalyzer` on macOS 26 and keep `SFSpeechRecognizer` as the macOS 13–15 fallback. The prototype uses `SFSpeechRecognizer` because it's the API we can typecheck and reason about today.
- Keep a `SpeechToText` seam so Deepgram (streaming, cloud) or local Whisper (accuracy) can plug in the way TTS providers do.

### The prototype (`packages/listen`)

- **Capture.** `AVAudioEngine` input tap, 1024-frame buffers. Each utterance gets its own `SFSpeechAudioBufferRecognitionRequest` with `requiresOnDeviceRecognition`, partial results on, and `taskHint = .dictation`.
- **End of utterance.** The utterance ends when **1.2 s pass with no new words** (`--silence-ms`, 200–10000). This is a transcript-driven endpoint: the timer re-arms whenever the partial transcript changes. It is not an audio-level VAD, so background noise doesn't hold the turn open, but a long thinking pause does end it.
- **Handover.** When an utterance ends:
  1. The prototype calls `endAudio()` on that request.
  2. It starts a new request right away, so no audio is lost.
  3. It waits up to 1.5 s for the final result, then falls back to the last partial.
- **Output.** One line per utterance, `{"final":true,"text":"…"}`, on stdout. With `--post <url>`, it POSTs the same JSON instead, adding `Authorization: Bearer` from `--token-file` when given. The token is re-read on every post and never logged.
- **Failures.**
  - A request that dies (for example, no speech for a long time) is restarted.
  - Five failures in a row within 2 s of starting exits 1, which catches cases like Dictation being disabled.
  - Missing on-device support, denied permissions, or no input device also exit 1.
  - Bad arguments exit 2.
- **Shutdown.** `SIGINT`/`SIGTERM` stops the engine, flushes the current utterance, and exits 0.

## 4. Turn-taking

1. **Push-to-talk first.**
   - Hold (or toggle) a hotkey. The helper already owns global hotkeys through Carbon, which needs no Accessibility permission.
   - Key down: stop or pause speech and open the mic.
   - Key up: finalize and send.
   - It's deterministic: no false triggers, no endpoint tuning, and no echo problem, because the mic is only open while you hold the key.
2. **Then end-of-speech detection.**
   - After Mouthpiece finishes speaking a reply, open a listening window (for example 8 s). The silence endpoint ends the turn.
   - The 1.2 s default is a starting point. Coding talk has long pauses, so expect to tune it, or add a spoken terminator ("send it", "over") as an option.
3. **Cancel words.** "Never mind" or "cancel" drops the utterance. "Stop" is handled as a Mouthpiece command (stop speech) instead of being sent to the agent.

## 5. Echo and barge-in

**The problem.** With speakers, the mic hears Mouthpiece's own voice. A naive always-on listener transcribes the reply and sends it back to the agent, creating a loop.

**What Phase 4 already gives us.** The helper's mic watcher pauses speech while any other process has the mic open, and resumes about 0.8 s after it closes, from the same chunk. That makes barge-in nearly free:
- **With push-to-talk,** pressing the key opens the mic. The watcher sees the listen process using input and pauses speech, so you are never talking over the reply. Because a new prompt arrives, the agent's next turn interrupts the old reply anyway (US-008).
- **With always-on listening,** the listener holds the mic open all the time, so the watcher would pause speech forever. Fix it this way:
  1. Add the listener's bundle id (`dev.mouthpiece.listen`, or the helper's own PID once it's merged into the helper) to `micPause.ignoreBundleIds`.
  2. Have the listener post `POST /v1/pause {"reason":"voice"}` on the first partial word (barge-in).
  3. On the final text, it either sends the text (then `interrupt`) or posts `resume` (for empty or cancel).

  The existing reason-keyed pause, its expiry, and resume-from-chunk carry over unchanged.
- **Echo cancellation.**
  - `AVAudioEngine` voice processing (`inputNode.setVoiceProcessingEnabled(true)`) cancels audio that plays through the *same* engine. Mouthpiece plays through `afplay` in another process, so Apple's echo cancellation probably won't remove it *(unverified)*.
  - Realistic options:
    - headphones (recommended and documented)
    - half-duplex: ignore transcripts while `GET /v1/status` says `speaking`, unless the barge-in pause fired first
    - later, playing audio through the helper's own engine so voice processing has a reference signal

## 6. Permissions and packaging

From the Phase 4 research, plus what building the prototype showed:

- **Usage strings.**
  - Speech recognition needs `NSSpeechRecognitionUsageDescription`, and the mic needs `NSMicrophoneUsageDescription`.
  - Both must be in the Info.plist of the **responsible process**; without them macOS kills the process when it asks.
  - Running the bare binary from Terminal makes Terminal the responsible process, so it will crash or prompt on Terminal's behalf. Always launch the `.app` with `open`.
- **Signing.** `build.ts` lays out `MouthpieceListen.app` with `Contents/Info.plist` (`dev.mouthpiece.listen`, `LSUIElement`). It compiles into `Contents/MacOS/mouthpiece-listen` and ad-hoc signs with `codesign -f -s - --identifier dev.mouthpiece.listen`, which binds the plist to the code. The opt-in test confirms that `codesign --verify --strict` passes on the result.
- **Rebuilds may reset permissions.** An ad-hoc signature's designated requirement is its code hash, so every rebuild probably looks like a new app to TCC and asks again. *(Unverified.)* Shipping (US-023) needs a stable Developer ID signature.
- **stdout under `open`.** An app launched by `open` doesn't inherit your terminal. Use `--stdout`/`--stderr` (see §8), or `--post`.
- **One app, one identity.** For v2, fold the listener into `MouthpieceHelper.app`. It is already a signed, `LSUIElement`, daemon-supervised bundle with the hotkeys. That means:
  - one TCC identity and one set of prompts
  - push-to-talk is local to the process that owns the mic
  - the mic watcher already excludes its own PID

  The catch: the helper would then need the two usage strings and would prompt for the mic. Ask lazily, only when conversation mode is first enabled.
- **SFSpeechRecognizer on-device** needs Dictation enabled for the locale. `supportsOnDeviceRecognition` is false until the model is present. The prototype exits 1 with a hint in that case.

## 7. Recommended v2 path

**Shape:** push-to-talk, on-device Apple STT inside the helper, tmux driver, existing Stop-hook output. Ship the smallest loop that is useful hands-on-keyboard, then grow it.

| Step | What | Estimate |
|---|---|---|
| 1. Conversation registry | Hooks report `TMUX_PANE` when present, through an additive, optional envelope field such as `replyTo: { tmux: "%3" }`, plus the conversation state (busy, idle, awaiting permission) from `UserPromptSubmit`/`Stop`/`Notification`. The daemon keeps `source + conversationId → { label, pane, state, lastSeen }` (PRD §12: the registry lives in the daemon). Contract and `docs/api.md` change together. | 1–1.5 days |
| 2. `POST /v1/converse {text, conversationId?}` | Authenticated. Picks the target: the given id, or the most recently active registered conversation. Sends through the source's driver only when it is idle; otherwise returns `409 busy` or `409 awaiting_permission`, which are spoken. Interrupts current speech. | 1 day |
| 3. Push-to-talk in the helper | Fold `MouthpieceListen` into the helper behind `--listen`. Use `SpeechAnalyzer` on macOS 26 with `SFSpeechRecognizer` as the fallback. On a hold-to-talk hotkey, pause speech, transcribe, then post `/v1/converse`. Add the usage strings, with a lazy permission prompt. | 2–3 days |
| 4. Verify by hand | tmux paste/Enter timing (add the delay if needed), `TMUX_PANE` in hook env, the permission flow, TCC after a rebuild, latency end to end. | 0.5 day |
| 5. Auto-listen | A listening window after each spoken reply, the silence endpoint, the barge-in pause with reason `voice`, cancel words, half-duplex gating. | 2 days |
| 6. Later: driver (b) | Headless `claude -p` stream-json with resume, plus spoken permission prompts through `--permission-prompt-tool`. Codex and Gemini equivalents follow once verified. | 3–5 days |

**Total:** about **5–6 days** to a working push-to-talk loop (steps 1–4), and about **2 weeks** including auto-listen and the headless driver.

**Open questions:**
- Does Wispr Flow expose any trigger or output API? If it does, Wispr could be the STT and we'd skip our own.
- Does Claude Code's TUI need a delay between the typed text and `Enter` when they come from `send-keys`?
- Is `TMUX_PANE` present in the hook environment for Claude Code, Codex, and Gemini?
- Does TCC re-prompt after every ad-hoc rebuild? (It affects development, not users.)
- `SpeechAnalyzer` vs `SFSpeechRecognizer` vs Whisper on coding vocabulary: measure word error rate on a few recorded prompts before choosing.
- With several agents running, how do you address one by voice? Options: a spoken label prefix ("mouthpiece: run the tests"), the most recent one, or a menubar picker.
- Does conversation mode run alongside the TUI (driver a) or replace it (driver b)? This spike suggests both: (a) for "voice on top of my terminal", and (b) for a fully hands-free mode.
- What happens during long autonomous runs mid-conversation? The registry state makes "Claude is still working" answerable. Whether to queue your next utterance is a product decision.

## 8. Trying the pieces by hand

None of this was run during the spike. These are the steps to try it yourself.

**tmux driver and `mouthpiece send`:**

```sh
brew install tmux
tmux new -s cc          # in a new terminal; then run `claude` inside it
# from another terminal:
bun run mouthpiece -- send --tmux cc "what files are in this directory?"
echo "summarize the README" | bun run mouthpiece -- send --tmux cc
tmux display -p -t cc '#{pane_id}'   # the %N id is also a valid target
```

- If Claude Code shows the text but doesn't submit it, that's the paste-detection risk from §2(a).
- If `tmux` is missing, `send` exits 1 with `install tmux: brew install tmux`.

**Listen prototype.** It asks for microphone and speech-recognition permission on first launch.

```sh
bun packages/listen/src/build.ts /tmp/mp-listen           # builds and ad-hoc signs, does not launch
open -W -n --stdout "$(tty)" --stderr "$(tty)" /tmp/mp-listen/MouthpieceListen.app
# speak; each utterance prints {"final":true,"text":"..."} after ~1.2 s of quiet
# options go after --args, e.g. --args --silence-ms 1500 --post http://127.0.0.1:9999/
pkill -INT -f mouthpiece-listen   # Ctrl-C on `open -W` does not stop the app
```

**Piping speech into the agent.** This is a crude end-to-end loop. An app launched by `open` can't write to a shell pipe, so it goes through a FIFO:

```sh
mkfifo /tmp/mp-listen.fifo
open -g -n --stdout /tmp/mp-listen.fifo /tmp/mp-listen/MouthpieceListen.app
while read -r line; do
  printf '%s' "$line" | jq -r .text | bun run mouthpiece -- send --tmux cc
done < /tmp/mp-listen.fifo
```

Use headphones: without them, the loop transcribes Mouthpiece speaking the reply (§5).
