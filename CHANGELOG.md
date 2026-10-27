# Changelog

## v0.2.1 — 2026-10-27

Fixes thirteen issues raised in the Copilot review of #8. All are local-state or
opt-in-path correctness fixes; the wire format, the option names and the default
`remember: "off"` are unchanged.

### Delivery state machine

- A crash between the append checkpoint and the request now leaves `sent`, and
  `sent` is never committed automatically. Committing an empty throw-away session
  archived nothing but recorded a receipt, silently discarding the statement.
- A confirmed append is persisted as `commit-pending` immediately, so a crash
  after the append retries the commit instead of appending the messages twice.
- New `awaiting` flag: when the model is asked to normalise the entry (or answer
  context is requested) the payload is not final, and neither the completion
  callback nor the worker may send the raw statement before finalisation. A lost
  completion notification is finalised as the raw statement after `idleSeconds`,
  or dropped when `rememberRawFallback` is off (counted as `rememberDropped`).
- A retried response can no longer rewrite or delete an event whose append may
  already have reached the server; only an unsent payload is finalisable.

### Review and reconciliation

- `resolve --approve` applies only to an unsent candidate; `--retry` applies only
  to `sent`/`uncertain` events. A confirmed append keeps commit-only retry
  semantics, so no resolution can trigger a second append. Each refusal now
  explains itself and exits non-zero.

### Triggers and scope

- A client tool continuation keeps the turn's remember classification, so its
  marker is still authorised and a rejected sensitive command is still excluded
  from capture.
- An explicit `/remember` releases a candidate that an assisted pattern queued
  for the same statement, instead of still demanding CLI approval.
- The throw-away OpenViking session is now conversation-scoped, so two
  conversations can no longer append to one session under separate locks.
  Deduplication was always conversation-local and is now documented as such.
- The CLI write now requires a non-`off` `remember` mode, matching the documented
  opt-in, and uses a per-invocation session.

### Privacy and i18n

- `rememberIncludeAnswer` no longer exports a sensitive answer: the same filter
  that guards the statement now guards the answer, which is omitted
  (`remember-answer-omitted`) instead of persisted.
- Answer context is included even when `rememberModel` is `off`.
- The candidate instruction no longer tells the user an entry was submitted when
  it is waiting for approval.
- A Responses request whose `input` is a bare string no longer loses the
  instruction.

### Upgrade and late-callback recovery

- v0.2.0 keyed remember events and receipts by the statement alone. Those legacy
  ids are still recognised inside the conversation that holds them, so an upgrade
  cannot write the same statement a second time or lose an unresolved delivery,
  and a legacy event keeps its original throw-away session.
- v0.2.0 events carry no `awaiting` flag. A legacy un-finalised payload is now
  treated as awaiting instead of being sent as if it were final, so an upgrade
  cannot bypass `rememberRawFallback: false`.
- Switching `remember` to `off` no longer restores a saved authorisation on a tool
  continuation. The turn's capture exclusion is kept; the write and its
  instruction are not.
- A late completion callback for an event the worker already delivered no longer
  reports `unavailable` (and no longer touches the missing event).
- A pending candidate accepts a corrected normalisation from a regenerated answer
  until it is approved and sent; only an attempted append is immutable.
- With `rememberIncludeAnswer`, an intermediate tool step keeps the payload
  awaiting so the final answer can still be attached, and a marker seen in a tool
  step is preserved for that final response.

### History branches and tool steps

- A remember classification is recomputed when it is missing on a history branch,
  so a rejected sensitive command cannot become ordinary conversation text after
  a branch switch and return. Continuations still never create new events.
- A payload awaiting its final answer stays awaiting through a tool-calling step
  that produced no final answer and no marker, instead of sending (or dropping)
  the raw statement before the model can normalise it.
- A normalisation cached from a tool step is used when the final answer omits the
  marker, so it is no longer deleted as "no normalised entry".
- A candidate's accepted normalisation is persisted before the flush that skips
  candidates, so a later marker-less callback cannot replace it with the raw
  statement.

### Capture exclusion independent of the write opt-in

- Remember classifications are no longer pruned by a history-branch switch; they
  decide capture exclusion and are bounded to the newest 64 anchors instead.
- When a classification is missing anyway (legacy state, or a long conversation)
  and `remember` is off, commands are still recognised so a previously rejected
  command is not captured as ordinary conversation text. The write stays off.
- Idle recovery uses a normalisation accepted earlier instead of falling back to
  the raw statement or dropping the event.

### Retention and legacy payloads

- A v0.2.0 event that already carried an answer is re-checked before it is sent,
  so a legacy payload cannot bypass the answer privacy filter.
- The per-turn classification no longer stores the statement text: it keeps the
  decision and the event id, and the text is recomputed from the client history.
  A delivered or dropped remember therefore leaves no second plaintext copy.
- The 64-anchor bound is applied after every insertion path (accepted plans,
  rejected commands and recovered continuations), not only for accepted plans.

### Independent audit round

An adversarial read-only review (three independent lanes: state machine, privacy
and retention, spec versus code) found eleven further defects; all are fixed.

- **Full outbox is a first-class outcome**: `remember-full` replaces a generic
  `skipped`, the instruction no longer tells the user the entry was submitted, and
  the callback no longer reports a duplicate for a write that was never queued.
- **`resolve --delivered` is guarded**: it refuses an event whose append never
  started (previously it recorded a receipt that locked that statement out of the
  conversation for good) and one whose commit is still owed.
- **`resolve` is unambiguous**: it locates the event across conversations first and
  refuses a legacy statement-only id that exists in more than one, unless
  `--state <id>` names one.
- **The privacy filter covers real credential shapes**: credentials in a URL,
  `sk_live_`/`rk_`/`pk_`, `AIza…`, `xoxb-…`, `github_pat_`, `glpat-`, `npm_`,
  authorization headers, cookies and `KEY=value` secrets. The README, design doc
  and this file now call it best-effort instead of implying a guarantee.
- **Answer context is bounded** by `rememberMaxChars` and omitted when oversized,
  like the statement.
- **Retention**: the lazy prune no longer spends its per-run budget on live states,
  and states written under another endpoint/credential are listed by `cli review`
  and `cli status` (`foreignBinding`) and aged out instead of lingering forever.
- **A command turn is never searched** in any script (`/记住 …` was still sent to
  the retrieval endpoint), and an empty `ctx.query` falls back to the request text
  instead of silently skipping recall and capture.
- **Idle measures inactivity** (`touchedAt`), so a generation longer than
  `idleSeconds` is not finalised early; an accepted normalisation is still used
  when the notification is lost.
- **The success code reflects the stored payload**: a cached normalisation reports
  `remembered`, not `remember-raw-fallback`.
- **`drain` keeps an idle capture candidate** when the outbox is full
  (`captureDeferred`) instead of discarding the turn.
- **The append checkpoint is durable on POSIX**: `save()` syncs the containing
  directory after the rename, so an OS crash cannot leave the pre-append file while
  the batch already landed (Windows has no directory handle to sync; documented).

### Upgrade note

Receipts and session IDs written by v0.2.0 remain valid: their statement-only ids
are still honoured inside the same conversation, so nothing is written twice and
no state migration is required. Only the session id of a *new* event changes,
because it is now conversation-scoped.

### Tests

100 tests (39 new) cover the crash window, awaiting finalisation, idle fallback
and drop, payload immutability after an attempted append, resolution guards,
candidate release, tool continuations, answer privacy, conversation-scoped
sessions, CLI opt-in and string Responses input. The capture-isolation test now
also proves that ordinary turns are still exported.

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
- A best-effort pattern filter refuses credential shapes (key prefixes,
  credentials in a URL, auth headers, cookies, `password=`), ID/phone numbers and
  medical identifiers before anything is queued (`remember-rejected`). It is a
  guard against accidents, not a DLP product.

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
