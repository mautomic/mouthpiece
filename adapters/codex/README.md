# @mouthpiece/adapter-codex

Codex CLI hook adapter for Mouthpiece (US-014). It sends the same `/v1/speak` events as the
Claude Code adapter, with `source: "codex"`.

What is spoken:
- **`Stop`** → `bun src/main.ts stop`: the turn's `last_assistant_message`, as a `codex`
  response labeled with the project directory.
- **`UserPromptSubmit`** → `bun src/main.ts prompt`: interrupts audio for that session only.
- **`Interrupt`** → `bun src/main.ts interrupt`: the same as `prompt`.
- **`PermissionRequest`** → `bun src/main.ts permission`: a short alert, "api needs your approval
  to use shell." (or "api needs your approval."). Alerts still play when the mode is `off`.

There is no transcript fallback, because Codex documents its session format as unstable. For a
Codex without hooks, use `mouthpiece tail --format codex` instead.

The hook runs on `@mouthpiece/hook-kit`: it never prints (stdout on `UserPromptSubmit` would
become model context), always exits 0 (exit 2 would block the prompt), gives up on the daemon
after 300 ms, and does nothing when `MOUTHPIECE_CHILD=1` is set.

## Install

```sh
mouthpiece install-hooks --target codex     # merges into $CODEX_HOME/hooks.json (~/.codex/hooks.json)
mouthpiece uninstall-hooks --target codex   # removes only Mouthpiece's entries
```

Then **open Codex and run `/hooks` to trust the Mouthpiece hooks**. Codex won't run a new or
changed hook until it is trusted, and the trust is tied to the hook's contents.

Notes:
- `install-hooks` keeps your other hooks, backs the file up, and is idempotent. Mouthpiece's
  entries are recognized by `/adapters/codex/src/main.ts` in their command.
- Hooks don't run in Codex cloud environments, only in the local CLI.
- Mouthpiece never touches `~/.codex/config.toml`. A legacy `notify` setting there is left alone
  and keeps working alongside the hooks.
- `./install.sh` runs `install-hooks --target codex` when `codex` is on your `PATH`.
