# Verification record

Last updated: 2026-10-27.

## Automated suite

| Check | Environment | Result |
| --- | --- | --- |
| `npm run check` | Node.js 24.12.0, Windows 11 | Syntax and Magpie manifest checks passed. |
| `npm test` | Node.js 24.12.0, Windows 11 | 100 passed, 0 failed, 1 skipped on Windows. |
| `bun test test/` | Bun 1.4.4, Windows 11 | 100 passed, 0 failed, 1 skipped on Windows. |

The suite uses real HTTP sockets against a mock OpenViking API and captured
protocol shapes. It covers immutable protocol handling, byte-identical replay
across plugin reconstruction, record pruning and budget recovery, prefix-drift
state scoping, wrapper sanitization, timeout derivation, credential scoping,
exclusive locks and stale-lock recovery, transient filesystem retries, lazy
state pruning, timeout and redirect behaviour, capture acknowledgement and
mismatch reporting, regeneration, idle draining and ambiguous-write suppression.

Remember coverage (`test/remember.test.mjs`, 60 tests): command and bare-command
detection with a previous-turn fallback, anchored-pattern candidates, secret and
sensitive-identifier refusal, an assertion that the injected control instruction
contains no CJK (the English-only i18n guard), wrapper-escape of untrusted text,
authorised-only parsing of the machine-readable marker (line and comment forms),
the locale-neutral payload header, one throw-away session per statement, no recall
and no capture on a remember turn, content deduplication, request retries that
keep a single event, model normalisation and raw fallback, uncertain-append
suppression, commit-only retry, candidate approval through the CLI, the
context-free `cli.mjs remember` write, stray-marker reporting, and the budget hint. Review regressions add the crash window (`sent` is never committed), `awaiting` finalisation and idle fallback/drop, payload immutability after an attempted append, resolution guards, candidate release by an explicit command, tool-continuation classification, answer-context privacy, conversation-scoped sessions, CLI opt-in and string Responses input; the capture-isolation test now also proves that ordinary turns are still exported. A second review pass adds v0.2.0 legacy receipt and event recovery, remember-off continuation, late-callback handling, candidate regeneration and tool-step awaiting, plus branch-switch reclassification, marker-less tool steps, cached markers, persisted candidate normalisation, classification durability across branch switches, mode-independent capture exclusion, idle recovery from a cached entry, legacy answer filtering, classification retention and the shared anchor bound. An independent adversarial audit round adds the full-outbox outcome, guarded and unambiguous resolution, credential-shape coverage, answer bounds, prune budget and foreign-binding aging, script-agnostic command detection, inactivity-based idle handling, stored-payload status codes and durable append checkpoints.

One assertion in `test/integration.test.mjs` checks that state files are created
`0600`. Windows has no POSIX mode bits (Node and Bun both report `0o666`), so it
is platform-guarded rather than faked. `.github/workflows/ci.yml` runs the same
suite on Linux, macOS and Windows, on Node 22 and 24, plus Bun.

## Live run against a real Magpie and a real OpenViking Server

Maintainer machine, 2026-10-27: Magpie gateway hooks loading this source folder,
OpenViking Server **v0.4.22** over Tailscale.

| Observed | Result |
| --- | --- |
| Hook routing | Magpie reported `ready` for the request; the model request was unchanged in `tools`/`model`/`stream`. |
| Recall | Local state held non-empty injected blocks of ~2.4–3.0 KB with 9–10 recalled entry URIs each, i.e. `POST /api/v1/search/search` with `mode=context`, `exclude_uris` and `stats` behaved as expected. |
| Credential scoping | All states shared one endpoint/credential binding fingerprint; no key material was written to disk. |

`GET /openapi.json` on that server was also compared field by field against this
implementation: `SearchRequest`, `AddMessageRequest`, `BatchAddMessageRequest`
and `UpdateSessionConfigRequest` accept every field this plugin sends, including
flat `turn_id`, `message_kind`, `source_message_ids` and `auto_commit_policy`
(no `options` nesting required).

## Not verified

- **The capture path has never written to a real OpenViking Server.** The live
  run above had `capture:false`; no `POST /sessions/{id}/messages/batch`, no
  session `config` PATCH and no server-side memory extraction has been observed
  end to end. API shape conformance is checked, behaviour is not. Treat
  `capture:true` as experimental until you validate it against your own server.
- **The remember path has never written to a real OpenViking Server either.**
  `messages/batch` and `/commit` (including the `task_id` receipt) are checked
  against `GET /openapi.json` and a mock server only. A live acceptance should
  use a throw-away account and then verify the archived session and the
  extraction task before connecting it to real conversations.
- OpenViking **v0.5.2** specifically: the implementation follows its documented
  API, but only a v0.4.22 server was available for the live run.
- Real model providers behind Magpie.
- Prompt-cache hit rate and TTFT/cost impact, with and without the hook. No
  performance claim is made.
- macOS and Linux runtime behaviour beyond the CI matrix (the maintainer's live
  run was on Windows).
- Recovery of a lost Magpie completion notification, and reconciliation of an
  `uncertain` append. Both are documented as manual, by design.
