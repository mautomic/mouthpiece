# Claude Code hook payloads (spike, US-001)

Real payloads captured from Claude Code **2.1.302** on 2026-10-17, running `claude -p` with hooks passed through `--settings` (no user settings were edited). The capture hook is `adapters/claude-code/spike/capture.ts`, and the HTTP echo server is `adapters/claude-code/spike/echo-server.ts`. Raw captures were written to `$MOUTHPIECE_HOME/spike/` with `MOUTHPIECE_HOME="$PWD/.spike-home"` (gitignored).

Paths are redacted: `~/…` stands for `/Users/<name>/…`, and `<project>` stands for the working directory.

## How the payloads were captured

```bash
export MOUTHPIECE_HOME="$PWD/.spike-home"
CAP="$(command -v bun) $PWD/adapters/claude-code/spike/capture.ts"
SETTINGS=$(printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s stop"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"%s prompt"}]}],"SessionStart":[{"hooks":[{"type":"command","command":"%s session-start"}]}]}}' "$CAP" "$CAP" "$CAP")
claude -p --settings "$SETTINGS" "Reply with exactly one short sentence: hello from the spike."
claude -p --settings "$SETTINGS" --allowedTools="Bash(ls:*)" "Run ls in the current directory, then tell me in one sentence how many entries there are."
```

Note: `--allowedTools` is variadic. Written as `--allowedTools "Bash(ls:*)" "<prompt>"`, it swallows the prompt and `claude -p` fails with "Input must be provided either through stdin or as a prompt argument". Use the `--allowedTools=...` form (or put the prompt before the flag).

Run 1 had no tool use. Run 2 called `Bash(ls)` before answering.

## Common fields

Every event carries these:

| Field | Type | Example |
|---|---|---|
| `session_id` | string (UUID) | `"954e4c88-09df-4f8a-a403-d6105ac77501"` |
| `transcript_path` | string (absolute path, `.jsonl`) | `"~/.claude/projects/<project-slug>/954e4c88-….jsonl"` |
| `cwd` | string (absolute path) | `"<project>"` |
| `hook_event_name` | string | `"Stop"`, `"UserPromptSubmit"`, `"SessionStart"` |

## `Stop`

Keys (both runs, identical set): `background_tasks`, `cwd`, `effort`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path`.

| Field | Type | Example |
|---|---|---|
| `session_id` | string | `"954e4c88-09df-4f8a-a403-d6105ac77501"` |
| `transcript_path` | string | `"~/.claude/projects/<project-slug>/954e4c88-….jsonl"` |
| `cwd` | string | `"<project>"` |
| `prompt_id` | string (UUID) | `"19621f3b-4322-4cce-8c36-32c1a545c017"` (matches the `UserPromptSubmit` of the same turn) |
| `permission_mode` | string | `"default"` |
| `effort` | object | `{ "level": "high" }` |
| `hook_event_name` | string | `"Stop"` |
| `stop_hook_active` | boolean | `false` |
| `last_assistant_message` | string | `"Hello from the spike."` |
| `background_tasks` | array | `[]` |
| `session_crons` | array | `[]` |

**`last_assistant_message` was present and non-empty in both runs:**

| Run | Tool use | `last_assistant_message` |
|---|---|---|
| 1 | none | `"Hello from the spike."` |
| 2 | `Bash(ls)` | ``"The current directory has 3 entries: `adapters`, `CLAUDE.md` and `docs`."`` |

In run 2 it holds only the final, post-tool-use text, not the pre-tool narration. It is raw Markdown (note the backticks), so it must go through the cleaning step (US-004). The adapter does not need to read `transcript_path` to get the response text.

Full example (run 1, redacted):

```json
{
  "session_id": "954e4c88-09df-4f8a-a403-d6105ac77501",
  "transcript_path": "~/.claude/projects/<project-slug>/954e4c88-09df-4f8a-a403-d6105ac77501.jsonl",
  "cwd": "<project>",
  "prompt_id": "19621f3b-4322-4cce-8c36-32c1a545c017",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "Hello from the spike.",
  "background_tasks": [],
  "session_crons": []
}
```

## `UserPromptSubmit`

Keys: `cwd`, `hook_event_name`, `permission_mode`, `prompt`, `prompt_id`, `session_id`, `transcript_path`.

| Field | Type | Example |
|---|---|---|
| `session_id` | string | `"954e4c88-09df-4f8a-a403-d6105ac77501"` |
| `transcript_path` | string | `"~/.claude/projects/<project-slug>/954e4c88-….jsonl"` |
| `cwd` | string | `"<project>"` |
| `prompt_id` | string (UUID) | `"19621f3b-4322-4cce-8c36-32c1a545c017"` |
| `permission_mode` | string | `"default"` |
| `hook_event_name` | string | `"UserPromptSubmit"` |
| `prompt` | string | `"Reply with exactly one short sentence: hello from the spike."` |

## `SessionStart`

Keys: `cwd`, `hook_event_name`, `session_id`, `source`, `transcript_path`.

| Field | Type | Example |
|---|---|---|
| `session_id` | string | `"954e4c88-09df-4f8a-a403-d6105ac77501"` |
| `transcript_path` | string | `"~/.claude/projects/<project-slug>/954e4c88-….jsonl"` |
| `cwd` | string | `"<project>"` |
| `hook_event_name` | string | `"SessionStart"` |
| `source` | string | `"startup"` |

## `http` hook type

**Supported.** A `Stop` hook of `{"type":"http","url":"http://127.0.0.1:7399/hook"}` sent one request to the echo server:

- Method: `POST`
- URL: `http://127.0.0.1:7399/hook` (the configured URL, unchanged)
- Headers:

  | Header | Value |
  |---|---|
  | `content-type` | `application/json` |
  | `accept` | `application/json, text/plain, */*` |
  | `accept-encoding` | `gzip, compress, deflate, br` |
  | `connection` | `keep-alive` |
  | `content-length` | `522` |
  | `host` | `127.0.0.1:7399` |
  | `user-agent` | `axios/1.15.2` |

- Body: the **same JSON object a `command` hook receives on stdin**, with the same keys as the `Stop` table above (`last_assistant_message` was `"ok"`).
- No `Authorization` header is sent by default. A daemon that requires a bearer token would need the hook config to add one (not tested here), or a thin command hook in between.
- The echo server answered `200 {}`, and `claude -p` finished normally.

## Pending (interactive)

These need an interactive Claude Code session and are captured by the human at the Phase 1 gate:

- [ ] **`Notification` payload:** the `notification_type` values (`permission_prompt`, `idle_prompt`) and the `message` text. `claude -p` does not raise these.
- [ ] **Async hook delay:** whether hooks with `async: true` add any noticeable delay (the time Claude Code waits) in an interactive session. Target ≈ 0 ms.
