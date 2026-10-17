# Mouthpiece HTTP API (v1)

Base URL: `http://127.0.0.1:7317` (port via `MOUTHPIECE_PORT`). The daemon binds loopback only.
Auth: every endpoint except `GET /v1/health` requires `Authorization: Bearer <token>`, where the token is the
contents of `$MOUTHPIECE_HOME/token` (default `~/.mouthpiece/token`).
Versioning: changes within `/v1` are additive only; unknown request fields are ignored.
Errors: JSON `{ "error": "<message>" }` with 400 (validation), 401 (auth), 404, 405, 413 (body > 1 MB).

## GET /v1/health
200 `{ "ok": true, "version": "0.1.0", "provider": "say", "queueDepth": 0 }`

## POST /v1/speak
Body (generic event envelope, PRD §8.3):

| Field | Type | Default | Notes |
|---|---|---|---|
| `text` | string, required | | ≤ 100,000 chars; markdown unless `format: "plain"` |
| `source` | string, required | | `^[a-z0-9][a-z0-9._-]{0,63}$`, e.g. `claude-code`, `discord`, `cli` |
| `conversationId` | string | `"default"` | unit of coalescing and interrupts (≤ 256) |
| `label` | string | none | spoken prefix when several conversations are active (≤ 100) |
| `kind` | `response` \| `alert` \| `info` | `response` | `response` items are subject to the trivial-text filter |
| `priority` | `high` \| `normal` \| `low` | `high` for alerts, else `normal` | higher priority jumps the queue, never interrupts |
| `mode` | `summary` \| `full` \| `off` | runtime override, then source profile, then `modes.default` | see `POST /v1/mode` for precedence |
| `format` | `markdown` \| `plain` | `markdown` | `plain` skips markdown cleaning |

202 `{ "id": "<item id>" }`, or 202 `{ "id": null, "skipped": "trivial" }` when filtered.
A new event replaces any not-yet-playing item from the same `source` + `conversationId`.

## POST /v1/interrupt
Body `{ "source": "claude-code", "conversationId": "abc" }` (omit `conversationId` for the whole source).
Stops that conversation's current item and drops its queued items. 200 `{ "stopped": true, "dropped": 1 }`

## POST /v1/stop
Stops everything and clears the queue. 200 `{ "stopped": true, "dropped": 3 }`

## POST /v1/skip
Skips the item currently playing. 200 `{ "skipped": true }`

## GET /v1/mode
200 `ModeState`: `{ "default": "summary", "overrides": [{ "source": "claude-code", "conversationId": "s1", "mode": "full" }] }`

## POST /v1/mode
Body: exactly one of `{ "mode": "summary"|"full"|"off" }`, `{ "toggle": true }` (summary↔full, off→summary), `{ "clear": true }`;
optional scope `source` (+ `conversationId`). No scope = global runtime mode. Returns 200 `ModeState`.
Precedence when speaking: event `mode` > conversation > source > global runtime > `profiles.<source>.mode` > config `modes.default`.
`off` mutes `response` items only; alerts always play.

## POST /v1/replay
Body `{ "full": false }`. Re-speaks the most recent item: what was spoken, or its full text with `full: true`.
200 `{ "id": "<new item id>" }` or `{ "id": null }` when there is nothing to replay.

## GET /v1/usage[?month=YYYY-MM]
200 `UsageReport`: rows grouped by provider and source for the month, or for the current billing cycle by default, plus quota status
for each provider listed under `[usage.quotas]`. `chars` excludes cache hits.

`POST /v1/speak` can additionally return `202 { "id": null, "skipped": "muted" }` (mode off) or `"duplicate"` (repeated alert).
