# Design and delivery semantics

## Request path

1. Require explicit enablement, a personal credential, a host-derived `local` origin and a session label.
2. Parse the original protocol without altering client-owned tool declarations, tool choice, reasoning or images. Skip server-managed Responses history and existing OV context blocks.
3. Scope state by endpoint/credential fingerprint, agent, working directory, Magpie session and protocol. The first-prefix hash is deliberately excluded: clients rewrite system/environment notices between requests, and that must not create a second state file or OpenViking session. Records remain keyed by complete-prefix anchors, so changed prefixes simply re-recall once.
4. Hash the unmodified complete prefix ending at each human message as a domain-separated hash chain (`sha256(anchor_previous + NUL + item)`), giving linear cost and the same uniqueness guarantee. A record belongs to that exact prefix, not merely to equal user text. v0.1.1 changed the chain seed; older anchor records are pruned and re-recalled once.
5. Replay historical records only for anchors present in the current history. Drop records outside it before computing the 512-record cap and the character budget, so compaction cannot permanently exhaust either. Search once for a new final user message, excluding already delivered URIs. Persist the exact block, or an empty result on failure, before returning the body.

Only named API fields are sent; the plugin never sends Magpie authorization headers to OV. The configured personal OV credential is authoritative. A remote caller's session/agent labels cannot choose another OV user.

The effective per-request timeout is `min(timeoutMs, gatewayTimeoutMs - 200)`, where `gatewayTimeoutMs` is the host budget (default 1000 ms). The worker has no host budget and uses `timeoutMs` directly. A derived value below 500 ms is reported as `skipped`. Failure is open for the model request. A timeout is frozen for this turn so retries do not rewrite old prefixes.

The `<openviking-context>` wrapper is a presentation boundary, not a security boundary. Recalled text is untrusted; case-insensitive, whitespace-tolerant open/close wrapper tags are entity-escaped before wrapping (and the escaped length is checked against `maxRecallChars`). General prompt-injection risk remains inherent to injecting retrieved text. Reported replay bytes are clamped to the host's 32768 limit.

## Remember path

The hook contract allows one inference request per client request and offers no
way to register a tool, so `remember` cannot be a tool call in this mode. It is
implemented as a deterministic trigger plus an ordinary write:

1. Only the latest user message is inspected, and only when it is the last item
   in the history. A leading command prefix (`/remember`, `/记住`, configurable)
   authorises a write; anchored preference patterns in `assisted` mode only
   produce a candidate that a human releases with `cli.mjs resolve --approve`.
2. The statement passes a privacy filter before anything is queued (keys,
   tokens, ID/phone/medical identifiers). A rejected statement is reported and
   never stored, and that turn is not captured either.
3. The event is appended to the same per-conversation outbox under
   `kind: "remember"`, keyed by a whitespace-insensitive hash of the statement.
   A repeat is reported as `remember-duplicate` instead of written twice.
4. The completion callback performs the write, because it runs with a timeout
   signal independent of the finished reply: `POST /sessions/{id}/messages/batch`
   on a throw-away session, then `POST /sessions/{id}/commit` with
   `keep_recent_count: 0`. Remember has its own per-request bound
   (`rememberTimeoutMs`) because it is two requests in one hook.
5. A state is therefore not capture's binary checkpoint. `pending` has not been
   sent; `sent` means the append outcome is unknown and is never resent;
   `commit-pending` means the append is confirmed and only the commit failed, so
   retrying the commit alone is safe. `uncertain` and `commit-pending` are only
   reconciled by an explicit CLI statement, matching the existing rule that the
   plugin never guesses about a non-idempotent write.

The model may normalise an entry, never authorise one. With
`rememberModel: "normalize"` the plugin appends one English instruction to the
outgoing request: English so a single reviewed control text serves every locale,
while the entry keeps the user's language and the confirmation sentence is
requested in the user's language. The instruction is never part of the client's
history, so replay anchors stay byte-identical. The reply is parsed for a
marker (`comment` or `line`) and the result is accepted only when the same turn
already passed the deterministic trigger; otherwise it is reported as
`remember-unrequested`. Unusable output falls back to the user's own words unless
`rememberRawFallback` is off, in which case the event is dropped as
`remember-dropped`. Tool-calling steps are parsed as well, because a marker is
not a final answer (`finalAnswer` would discard those replies).

A remember turn does not recall and is not captured: the two write paths would
extract the same statement twice, and the message is an instruction the user
already issued rather than a question.

## Capture path

The completion callback ignores interrupted replies, tool calls, truncated output and non-visible reasoning. It holds one candidate answer. The next complete client history must contain that answer after its user-message anchor before it is queued; comparison collapses whitespace so clients that re-render text still acknowledge. A candidate that disappears without matching is dropped and reported as `mismatch`. Regeneration updates the held candidate. The worker can export the latest idle candidate after a configured delay, following an explicit opt-in.

The outbox writes a checkpoint before a non-idempotent batch append. Once sending starts its status is `uncertain`; only a successful API response clears it and retains a local receipt hash. An exception, cancellation or process crash leaves the uncertain record for inspection. Later events in that session cannot pass it.

Session auto-create and config PATCH may be retried before append. Message append is not assumed idempotent: the OpenViking v0.5.2 session code creates message IDs independently of `source_message_ids`. This integration deliberately accepts a manual reconciliation step instead of advertising exactly-once delivery it cannot guarantee.

The companion worker does not recover a Magpie completion notification that never reached the plugin. OV's own server scheduler handles extraction after successful writes. It must be enabled for idle commits.

## Local state

Local files are transport/replay state, not a second long-term memory database. Keys are never written. Replay records contain private recalled context. Capture candidates/outbox records contain opt-in text until acknowledged/exported. Receipt records contain only hashes.

State files are atomically replaced and protected by exclusive per-file locks. Concurrent requests fail open instead of racing a writer. Locks are not automatically stolen; `node cli.mjs unlock` lists owners and removes only locks whose recorded process is confirmed gone on this host (`--force` covers another host or an unreadable owner, never a live process). Rename/unlink operations retry transient Windows `EPERM`/`EBUSY`/`EACCES` failures with a short backoff.

Replay-only requests do not rewrite the state file; a dirty flag suppresses writes when nothing changed (an hourly heartbeat still refreshes the TTL). A small non-secret label (agent, cwd basename, hashed session prefix, protocol, created time) is stored so `cli.mjs status` can show scope drift and last-used/pending ages. Worker cleanup removes expired replay files only when they contain no candidate or unresolved export; an at-most-hourly lazy prune at request time applies the same rule for users who never run the worker. Uncertain exports intentionally outlive the replay TTL until reconciled.

## Deliberately outside v0.2

- Multi-user or remote gateway credential mapping.
- An in-gateway tool execution loop, MCP registration, Rule enforcement or compaction policy. Remember exists precisely because this is unavailable.
- Model-initiated remember (`propose`) and an out-of-band extractor that judges relevance without a user phrase. Both would let untrusted text choose what enters long-term memory.
- Automatic reconciliation of `uncertain` appends or `commit-pending` commits.
- Recovering missing full histories from Responses IDs.
- Guaranteed delivery across a lost completion notification or lost local disk.
- Cost reduction or TTFT claims without an end-to-end benchmark.

## Acceptance status

Done on the maintainer's machine (2026-10-27): installed into a real Magpie build, confirmed the `origin`/session values of the actual client, and ran real recalls against a live OpenViking Server **v0.4.22** — non-empty blocks of ~2.4–3.0 KB with 9–10 entry URIs, unchanged client `tools`/`model`/`stream`. The request bodies were cross-checked field by field against that server's `/openapi.json`. See [verification.md](verification.md).

Still **not** done, and not claimed anywhere in this repository:

- One confirmed capture end to end (`messages/batch` → session `config` → server-side memory extraction). The write path has only been checked against the OpenAPI schema and a mock server; the live run had `capture:false`.
- A live run against OpenViking v0.5.2 (documented target) as opposed to v0.4.22.
- TTFT, prompt-cache hit rate or cost comparison with the hook disabled.
- macOS/Linux runtime behaviour beyond the CI matrix.

The automated suite uses real HTTP sockets with a mock OpenViking API and captured protocol shapes, on Node 22 and Bun 1.4.4. It contains 40 tests: records pruning/budget, prefix-drift scope, wrapper sanitization, timeout derivation, outbox/capture edge cases, lock recovery, lazy pruning, filesystem retry and API error classification, plus the original protocol and integration coverage.
