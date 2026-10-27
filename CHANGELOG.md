# Changelog

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
