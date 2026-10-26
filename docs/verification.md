# Verification record

Last updated: 2026-10-27.

## Automated suite

| Check | Environment | Result |
| --- | --- | --- |
| `npm run check` | Node.js 22.19.0, Windows 11 | Syntax and Magpie manifest checks passed. |
| `npm test` | Node.js 22.19.0, Windows 11 | 22 passed, 0 failed. |
| `bun test test/` | Bun 1.4.4, Windows 11 | 22 passed, 0 failed. |

The suite uses real HTTP sockets against a mock OpenViking API and captured
protocol shapes. It covers immutable protocol handling, byte-identical replay
across plugin reconstruction, credential scoping, exclusive locks, timeout and
redirect behaviour, capture acknowledgement, regeneration, idle draining and
ambiguous-write suppression.

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
- OpenViking **v0.5.2** specifically: the implementation follows its documented
  API, but only a v0.4.22 server was available for the live run.
- Real model providers behind Magpie.
- Prompt-cache hit rate and TTFT/cost impact, with and without the hook. No
  performance claim is made.
- macOS and Linux runtime behaviour beyond the CI matrix (the maintainer's live
  run was on Windows).
- Recovery of a lost Magpie completion notification, and reconciliation of an
  `uncertain` append. Both are documented as manual, by design.
