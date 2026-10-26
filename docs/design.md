# Design and delivery semantics

## Request path

1. Require explicit enablement, a personal credential, a host-derived `local` origin and a session label.
2. Parse the original protocol without altering client-owned tool declarations, tool choice, reasoning or images. Skip server-managed Responses history and existing OV context blocks.
3. Scope state by endpoint/credential fingerprint, agent, working directory, Magpie session, protocol and the first complete user-message prefix.
4. Hash the unmodified complete prefix ending at each human message. A record belongs to that exact prefix, not merely to equal user text.
5. Replay historical records. Search once for a new final user message, excluding already delivered URIs. Persist the exact block, or an empty result on failure, before returning the body.

Only named API fields are sent; the plugin never sends Magpie authorization headers to OV. The configured personal OV credential is authoritative. A remote caller's session/agent labels cannot choose another OV user.

The API request timeout should be shorter than the Magpie hook deadline. Failure is open for the model request. A timeout is frozen for this turn so retries do not rewrite old prefixes.

## Capture path

The completion callback ignores interrupted replies, tool calls, truncated output and non-visible reasoning. It holds one candidate answer. The next complete client history must contain that exact answer after its user-message anchor before it is queued. Regeneration updates the held candidate. The worker can export the latest idle candidate after a configured delay, following an explicit opt-in.

The outbox writes a checkpoint before a non-idempotent batch append. Once sending starts its status is `uncertain`; only a successful API response clears it and retains a local receipt hash. An exception, cancellation or process crash leaves the uncertain record for inspection. Later events in that session cannot pass it.

Session auto-create and config PATCH may be retried before append. Message append is not assumed idempotent: the OpenViking v0.5.2 session code creates message IDs independently of `source_message_ids`. This integration deliberately accepts a manual reconciliation step instead of advertising exactly-once delivery it cannot guarantee.

The companion worker does not recover a Magpie completion notification that never reached the plugin. OV's own server scheduler handles extraction after successful writes. It must be enabled for idle commits.

## Local state

Local files are transport/replay state, not a second long-term memory database. Keys are never written. Replay records contain private recalled context. Capture candidates/outbox records contain opt-in text until acknowledged/exported. Receipt records contain only hashes.

State files are atomically replaced and protected by exclusive per-file locks. Concurrent requests fail open instead of racing a writer. Locks are not automatically stolen. Worker cleanup removes expired replay files only when they contain no candidate or unresolved export. Uncertain exports intentionally outlive the replay TTL until reconciled.

## Deliberately outside v0.1

- Multi-user or remote gateway credential mapping.
- An in-gateway tool execution loop, MCP registration, Rule enforcement or compaction policy.
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

The automated suite uses real HTTP sockets with a mock OpenViking API and captured protocol shapes, on Node 22 and Bun 1.4.4.
