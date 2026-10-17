# @mouthpiece/adapter-claude-code

Claude Code hook adapter for Mouthpiece (US-007, US-008, US-012).

- **`Stop`** → `bun src/main.ts stop`: sends `last_assistant_message` (falling back to the
  transcript) to the daemon as a `claude-code` response, labeled with the project directory.
- **`UserPromptSubmit`** → `bun src/main.ts prompt`: interrupts audio for that session only.
- **`Notification`** → `bun src/main.ts notify`: speaks a short `alert`:
  - `permission_prompt`: "web needs your approval to use Bash." (or "web needs your approval.")
  - `idle_prompt` (opt-in): "web is waiting for you."
  - Other notification types are ignored. Alerts still play when the mode is `off`.

The hook never writes to stdout, always exits 0, and gives up on the daemon after 300 ms (FR-2).
It does nothing when `MOUTHPIECE_CHILD=1` is set.

## Install

The normal path (US-011):

```sh
mouthpiece install-hooks                # Stop, UserPromptSubmit, Notification (permission_prompt)
mouthpiece install-hooks --idle-alerts  # also speak when Claude Code is waiting for input
mouthpiece uninstall-hooks              # removes only Mouthpiece's entries
```

`install-hooks` merges into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`):
- It keeps your other hooks, permissions, and keys.
- It backs the file up to `settings.json.bak-mouthpiece-<timestamp>` and writes atomically.
- Re-running it is idempotent.
- It refuses to touch a file that isn't valid JSON.

Mouthpiece's entries are recognized by `/adapters/claude-code/src/main.ts` in their command.
All of them are registered with `async: true`. `./install.sh` runs `install-hooks` for you.

## Try it without installing

This leaves `~/.claude/settings.json` alone:

```sh
claude --settings "$(bun adapters/claude-code/src/dev-settings.ts)"
```
