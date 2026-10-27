# Changelog

## v0.2.0 — 2026-10-27

Adds explicit `remember` to the gateway-hook mode. Everything is opt-in:
`remember` defaults to `off`, and with it off the plugin behaves exactly as
v0.1.1 did. State files stay compatible (an absent `remembered` array is added
on first load); no migration step is required.

### Remember

- New `remember` option (`off`, `command`, `assisted`). A leading `/remember` or
  `/记住` command — or a bare command, which remembers the previous user message —
  authorises a write. In `assisted` mode anchored preference phrases only queue a
  candidate that a human releases with `cli.mjs resolve --approve`.
- `remember` is not a tool: the hook contract allows one inference request per
  client request, so the write happens as `POST /sessions/{id}/messages/batch`
  plus `POST /sessions/{id}/commit` on a throw-away session, in the completion
  callback where the timeout is independent of the finished reply.
- Events live in the existing outbox under `kind: "remember"` with three
  distinct states: `pending` (not sent), `sent` (append outcome unknown, never
  resent automatically) and `commit-pending` (append confirmed, only the commit
  is retried). Uncertain appends and ambiguous commits are reconciled only by an
  explicit CLI statement.
- Content is deduplicated by a whitespace-insensitive hash of the statement, so a
  retry, a regenerated answer or a replay cannot write the same entry twice.
  A remember turn never recalls and is never also captured.
- Secrets, API keys, ID/phone/medical identifiers are refused before anything is
  queued (`remember-rejected`).

### Model normalisation

- `rememberModel: "normalize"` appends **one English control instruction** to the
  outgoing request — English on purpose so a single reviewed text serves every
  locale; the entry keeps the user's language and the confirmation sentence is
  requested in the user's language. The instruction never enters the client's
  history, so replay anchors stay byte-stable.
- The model's machine-readable marker (`rememberMarker: "comment" | "line"`) is
  accepted only when the same turn already passed the deterministic trigger;
  otherwise it is reported as `remember-unrequested`. Tool-calling steps are
  parsed too, because a marker is not a final answer.
- Unusable model output falls back to the user's own words
  (`remember-raw-fallback`); `rememberRawFallback: false` drops the request
  instead (`remember-dropped`).

### CLI and diagnostics

- New `cli.mjs remember --text|--file` writes an entry with no conversation
  state; `cli.mjs review` lists unresolved remember events without printing text;
  `cli.mjs resolve <event-id> --approve|--retry|--delivered` records a human
  decision. `flush` and `status` now process and count remember events.
- New status codes: `remember-queued`, `remember-pending`, `remembered`,
  `remember-raw-fallback`, `remember-rejected`, `remember-duplicate`,
  `remember-dropped`, `remember-unrequested`, `remember-uncertain`,
  `remember-commit-pending`, `remember-timeout`.
- `remembered` means *archived plus extraction committed*, not *memory exists*.
  `POST /commit` returns a `task_id`; extraction decides in the background.

### Still not verified

- The remember write path has only been exercised against a mock server and the
  server's OpenAPI schema. No live OpenViking Server has ever received a
  plugin-issued remember. Treat it as experimental until validated against a
  throw-away account.

## v0.1.1 — 2026-10-27

Fixes all seven issues reported against v0.1.0 (#1–#7).

### Recall and replay

- Prune replay records whose anchor is absent from the current history before
  applying the 512-record cap and `maxWindowChars` budget. Compaction,
  regeneration and abandoned branches can no longer disable recall permanently.
  Empty/failed records are pruned with their history and recycled first when the
  cap is reached (#1).
- Replay scope now uses stable conversation identity only: credential binding,
  agent, cwd, Magpie session and protocol. A rewritten system/environment notice
  no longer creates a new state file and OpenViking session (#4).
- Prefix anchors are an incremental, domain-separated hash chain instead of a
  full-prefix re-serialisation per turn. Anchor cost is linear on long histories (#3).
- `inject()` returns `undefined` when no turn has a recorded block and no longer
  deep-clones the body or item array. Injected turns are copied shallowly (#3).
- Replay-only requests (tool steps, retries) no longer rewrite the state file;
  a dirty flag permits writes only for actual changes, with an hourly TTL
  heartbeat (#3).
- Recalled text has wrapper-like `<openviking-context …>` tags entity-escaped
  before injection, and the escaped length is checked against `maxRecallChars` (#5).
- Reported replay bytes are clamped to Magpie's 32768 host limit (#2).
- `state.records`/`state.updated` now carry a small non-secret label (agent,
  cwd basename, hashed session prefix, protocol, created time) so `cli.mjs
  status` shows scope drift, last-used time and pending ages (#4, #6).

### Capture and outbox

- `enqueue()` no longer throws when the 64-entry outbox is full. It drops the
  capture and reports `skipped`; recall and the replay anchor are unaffected (#2).
- `drain()` counts successful appends directly, so it reports deliveries even
  when the 1024-entry `delivered` receipt list is already full (#2).
- Acknowledgement normalises whitespace, and an acknowledged-then-missing
  candidate is reported as `mismatch` instead of disappearing silently (#2).
- Full-outbox drops do not abort the surrounding state operation (#2).

### Timeouts and errors

- Effective hook timeout is derived as `min(timeoutMs, gatewayTimeoutMs - 200)`.
  Magpie's 1000 ms default now yields an 800 ms recall budget instead of a
  guaranteed host abort; a derived budget below 500 ms reports `skipped`. The
  worker keeps the explicit `timeoutMs` and ignores the host budget (#7).
- OpenViking errors distinguish 401/403 (`unauthorized`), other 4xx
  (`invalid`), and 408/429/5xx/network (`unavailable`) (#6).

### State directory lifecycle

- New `node cli.mjs unlock [--force] [options.json] [state-id]` lists lock
  owners and removes only locks whose recorded process is confirmed gone on
  this host. A live process is never unlocked (#6).
- Expired idle states are pruned by the worker and by an at-most-hourly lazy
  prune during requests; states with a candidate or unresolved export are
  retained (#6).
- File replacement and lock removal retry transient Windows
  `EPERM`/`EACCES`/`EBUSY` failures with a short backoff (#6).

### Upgrade notes

- **Anchor derivation changed.** Replay records created by v0.1.0 use the old
  full-prefix hash and will be pruned; affected turns recall once more. This is
  a one-time replay-scope reset, not data loss outside the local state directory.
- **Replay scope key changed.** v0.1.0 state files are not reused by v0.1.1.
  Old files expire through the normal TTL/worker/lazy-prune path.
- `gatewayTimeoutMs` is now read by the plugin to derive its own timeout. Keep
  the recommended value of 3000 ms or more.

### Tests

- 40 automated tests (was 22), including the issue acceptance cases: 600-turn
  compacted history, live-record cap, prefix drift, sanitized wrapper, full
  outbox, whitespace acknowledgement, 1024-entry delivered list, byte clamp,
  timeout derivation, stale-lock recovery, lazy pruning and transient rename retry.
