# @mouthpiece/adapter-devin

Devin CLI hook adapter for Mouthpiece. It sends the same `/v1/speak` events as the Codex adapter,
with `source: "devin"`.

What is spoken:
- **`Stop`** → `bun src/main.ts stop`: the turn's `last_assistant_message`, as a `devin` response
  labeled with the project directory (Devin's payloads have no `cwd`, so the label comes from the
  `DEVIN_PROJECT_DIR` environment variable).
- **`UserPromptSubmit`** → `bun src/main.ts prompt`: interrupts audio for that session only.
- **`PermissionRequest`** → `bun src/main.ts permission`: a short alert, "api needs your approval
  to use exec." (or "api needs your approval."). Alerts still play when the mode is `off`.

There is no transcript fallback and no Orca reply route. Payload shapes were captured from Devin
CLI 3000.11.92; the `PermissionRequest` payload is assumed to match Devin's docs (`tool_name`).

The hook runs on `@mouthpiece/hook-kit`: it never prints (stdout is parsed by Devin as a hook
decision), always exits 0 (exit 2 would block), gives up on the daemon after 300 ms, and does
nothing when `MOUTHPIECE_CHILD=1` is set.

## Install

```sh
mouthpiece install-hooks --target devin     # merges into ~/.config/devin/config.json ("hooks" key)
mouthpiece uninstall-hooks --target devin   # removes only Mouthpiece's entries
```

Then open Devin and run `/hooks` to confirm the three Mouthpiece hooks loaded.

Notes:
- `install-hooks` keeps your other settings and hooks, backs the file up, and is idempotent.
  Mouthpiece's entries are recognized by `/adapters/devin/src/main.ts` in their command.
- Devin also reads Claude Code hooks from `~/.claude/settings.json`, but discards that whole file
  if it contains an event Devin doesn't know (such as `StopFailure`, added by Orca). That is why
  this adapter installs into Devin's own config instead of relying on the Claude Code hooks.
- `./install.sh` runs `install-hooks --target devin` when `devin` is on your `PATH`.
