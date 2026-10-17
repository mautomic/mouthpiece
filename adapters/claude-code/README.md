# @mouthpiece/adapter-claude-code

Claude Code hook adapter for Mouthpiece (US-007, US-008).

- **`Stop`** → `bun src/main.ts stop`: sends `last_assistant_message` (falling back to the
  transcript) to the daemon as a `claude-code` response, labeled with the project directory.
- **`UserPromptSubmit`** → `bun src/main.ts prompt`: interrupts audio for that session only.

The hook never writes to stdout, always exits 0, and gives up on the daemon after 300 ms (FR-2).
It does nothing when `MOUTHPIECE_CHILD=1` is set.

Try it without editing `~/.claude/settings.json`:

```sh
claude --settings "$(bun adapters/claude-code/src/dev-settings.ts)"
```

`mouthpiece install-hooks` arrives in Phase 2 (US-011).
