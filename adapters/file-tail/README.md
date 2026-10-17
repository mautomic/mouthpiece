# @mouthpiece/adapter-file-tail

The fallback for tools without hooks (US-014): follow a session log or any text log and speak
each new final message through the same `/v1/speak` contract.

```sh
mouthpiece tail --format codex                   # ~/.codex/sessions (or $CODEX_HOME/sessions)
mouthpiece tail --format gemini                  # ~/.gemini/tmp (or $GEMINI_HOME/tmp)
mouthpiece tail --format lines --path build.log  # every new line
```

Options: `--path <file-or-dir>`, `--source <name>` (default: the format, `cli` for `lines`),
`--label <label>`. It runs in the foreground until Ctrl-C and prints `following <file>` to stderr
whenever it switches files. If the daemon can't be reached, it prints a warning and keeps going.

## Formats

| Format | Files | Spoken |
|---|---|---|
| `codex` | `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | `event_msg` lines whose `payload.type` is `task_complete`: `payload.last_agent_message`. The uuid is the conversation id. |
| `gemini` | `tmp/<project>/chats/session-<ts>-<id>.jsonl` | Messages with `type: "gemini"`; `content` is a string or a list of `{text}` parts. Mutation lines (`$patch`, `$set`, `$rewindTo`) are ignored. |
| `lines` | the file given by `--path` | Each non-empty line. |

The Codex and Gemini session formats are undocumented and may change. Prefer the hook adapters
(`mouthpiece install-hooks --target codex|gemini`) when your tool supports them.

## How following works (`FileTailer`)

- It starts at the **end** of the file, so history is never spoken. A file that appears after
  start is read from its beginning.
- Given a directory, it follows the most recently modified file matching the format's pattern,
  up to 4 levels deep. When a newer one appears, it reads the rest of the current file, then
  switches and never goes back to the old one. Two sessions running at once are not both
  followed: only the newest one is.
- Partial lines are buffered until their newline arrives, including split multi-byte characters.
- Truncation or rotation (a smaller file, a new inode, or changed bytes before the read offset)
  restarts from 0, so old content is not re-read and nothing is spoken twice.
- The file system is injectable (`TailFs`); `poll()` is public for tests.
