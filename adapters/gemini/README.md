# @mouthpiece/adapter-gemini

Gemini CLI hook adapter for Mouthpiece (US-014). It sends the same `/v1/speak` events as the
Claude Code adapter, with `source: "gemini"`.

What is spoken:
- **`AfterAgent`** → `bun src/main.ts stop`: the turn's `prompt_response`, as a `gemini`
  response labeled with the project directory.
- **`BeforeAgent`** → `bun src/main.ts prompt`: interrupts audio for that session only.
- **`Notification`** → `bun src/main.ts notify`: for `ToolPermission` notifications, a short
  alert, "site needs your approval to use run_shell_command." (or "site needs your approval.").

## Install

```sh
mouthpiece install-hooks --target gemini     # merges into $GEMINI_HOME/settings.json (~/.gemini/settings.json)
mouthpiece uninstall-hooks --target gemini   # removes only Mouthpiece's entries
```

Gemini CLI hooks are enabled by default; manage them with `/hooks panel`. `install-hooks` keeps
your other settings and hooks, backs the file up, and is idempotent. Mouthpiece's entries are
named `mouthpiece-*` and recognized by `/adapters/gemini/src/main.ts` in their command.
`./install.sh` runs it when `gemini` is on your `PATH`.

## Why the hook must stay silent

Gemini runs hooks synchronously and reads their output:
- Anything on stdout (or, failing that, stderr) is parsed as a hook result; plain text on exit 0
  becomes a system message in your session.
- An exit code other than 0 or 1 is a deny, and a deny on `AfterAgent` makes Gemini **retry the
  turn**.

So this hook, through `@mouthpiece/hook-kit`, prints nothing to stdout or stderr, always exits 0,
gives up on the daemon after 300 ms, exits hard after 1 s, and does nothing when
`MOUTHPIECE_CHILD=1` is set. `src/main.test.ts` checks this against bad input, a dead daemon, and
a hanging daemon.
