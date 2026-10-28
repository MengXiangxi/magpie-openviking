# magpie-openviking

[中文说明](README.zh-CN.md) · MIT · Experimental v0.2.1

Developed by **开放维京特工@飞书** (a Feishu agent) · maintained by **[MengXiangxi](https://github.com/MengXiangxi)**.

**Status:** recall is verified live against a Magpie hook host and an OpenViking Server v0.4.22. Capture is implemented and schema-checked but **not yet acceptance-tested against a live server**; explicit remember is implemented and mock-verified but **has never written to a live server** — see [docs/verification.md](docs/verification.md).

OpenViking memory inside Magpie's **asynchronous gateway hooks**. Magpie still sends the model request directly to its selected provider; OpenViking Server is a side API for retrieval and optional conversation capture. An extra OpenViking model gateway is not required.

```text
Agent ──► Magpie + this hook ──► model provider
                   │
                   └─────────► OpenViking Server
                               search / sessions / memory extraction
```

## What it implements

- Recall through `POST /api/v1/search/search`, `mode=context`, with bounded context size. Query expansion and digest rewriting are off by default.
- Append context to a new user message. Persist and replay exactly the same injection on later complete-history requests, including tool steps and retries.
- Chat Completions, Anthropic Messages, full-history Responses and Gemini request/reply adapters. Client tool declarations, tool choice, images, reasoning blocks, model selection and streaming flags are preserved.
- Explicitly opt-in text capture. A final answer is held until the next client history acknowledges it; regeneration replaces an unconfirmed answer. An optional worker flushes the last idle turn.
- Explicitly opt-in **remember** from the user's own words. A leading `/remember` (or `/记住`) command, or an anchored preference phrase, writes one throw-away session and commits it for extraction. Rules decide *whether*; the model may only normalise *what*.
- Local transport outbox. An append with an uncertain outcome is **not** automatically resent: OpenViking `source_message_ids` are provenance, not idempotency keys.
- No runtime npm dependencies and no hidden model/tool execution loop.

This is an independent community integration, not an official Magpie or OpenViking plugin.

## Requirements and verification scope

- A Magpie build with `magpie.hooks`, async `onRequest`/`onResponse`, `ctx.origin`, and private request `ctx.state`. Older synchronous JS middleware alone is insufficient. See [Magpie's contract](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md).
- A per-plugin `gatewayTimeoutMs` of **3000 ms or more** is recommended. The plugin derives its effective request timeout as `min(timeoutMs, gatewayTimeoutMs - 200)`, so Magpie's 1000 ms default yields an 800 ms recall budget instead of a guaranteed abort. A derived budget below 500 ms is reported as `skipped`. `gatewayTimeoutMs` is a per-plugin option read by Magpie's host, not a global Magpie setting, and Magpie's `package.json` `magpie.options` block is only a printed suggestion.
- OpenViking Server with context search, session batch messages and session config APIs. The implementation follows the **v0.5.2** public API and was run live against **v0.4.22**; both accept every field sent here.
- Node.js 22+ for the worker/tests; Magpie runs the plugin in its own Bun host.
- A personal OpenViking **user/admin API key**, available to the Magpie process as an environment variable. Do not use a Root key.

Automated verification covers protocol fixtures and real local HTTP requests to a mock OpenViking server, on Node and on Bun. **Recall** has also been verified live against a real Magpie host and a real OpenViking server. **Capture has not**: the write path is only checked against the server's OpenAPI schema, so no live server has ever received a captured turn from this plugin. Real model providers, memory extraction, prompt-cache hit rate and latency/cost impact remain unmeasured, and no performance claim is made. Details: [docs/verification.md](docs/verification.md).

## Install

Install from GitHub, then save the options once:

```sh
magpie plugin add github:MengXiangxi/magpie-openviking
magpie plugin options magpie-openviking '{"enabled":true,"capture":false,"url":"http://127.0.0.1:1933","apiKeyEnv":"OPENVIKING_API_KEY","maxTokens":1200,"timeoutMs":1500,"gatewayTimeoutMs":3000}'
```

Pin the release instead of tracking the default branch with `github:MengXiangxi/magpie-openviking#v0.2.1`; `magpie plugin update magpie-openviking` moves an unpinned install forward. There is no npm publication and no build step. Upgrading from v0.1.x keeps every option working: `remember` defaults to `off`, state files gain their receipt list on first load and need no migration. See [CHANGELOG.md](CHANGELOG.md).

For local development, install the checkout in place instead. Run `npm run check` and `npm test` (or `npm run test:bun`) first, then:

```sh
magpie plugin add /absolute/path/to/magpie-openviking
```

Set `OPENVIKING_API_KEY` using your operating system's environment/secret facilities **before starting Magpie**, then restart Magpie so its Bun host inherits it. A shell export does not necessarily reach a desktop application launched from a menu. Never put the secret in this repository, plugin options, an issue or a chat. Options contain the **environment variable name**, not its value.

The `magpie plugin options` line above is **not optional**: `package.json`'s `magpie.options` block is only a suggestion that `magpie plugin options <name>` prints, and Magpie never applies it by itself. **Saved options do not reach a host that already loaded the plugin**: toggle the plugin off and on (`magpie plugin off magpie-openviking`, then `on`) or restart Magpie, otherwise the running host keeps the previous values — this was measured live: a `remember` command was ignored until the toggle, and worked immediately afterwards. There are also two independent switches — Magpie's per-plugin on/off toggle and `enabled` in these options. Both must be on; a plugin switched on in the GUI with no saved options reports `skipped`.

A folder install is loaded in place, so keep the folder present and change options or toggle the plugin to pick up source edits. A GitHub install is a clone Magpie keeps and refreshes itself. An npm install/build step is unnecessary in both cases.

Start a new complete-history chat. Magpie's Plugins page should report `ready` or `empty`. `unbound` usually means the credential/session is absent, or the request is not classified as a direct local request.

Hook status codes: `ready` (a block was injected), `empty` (recall returned nothing), `skipped` (options, budget or query not eligible), `unbound` (missing credential/session/origin), `unavailable` (timeout, network or 5xx), `unauthorized` (401/403), `invalid` (other 4xx or a malformed response), and `mismatch` (a held capture answer never reappeared in the client history; recall is unaffected). Remember adds `remember-queued` (accepted, not sent yet), `remember-pending` (queued or awaiting review), `remembered` (archived and committed; extraction runs in the background), `remember-raw-fallback` (the model gave no normalised entry, the user's own words were stored), `remember-answer-omitted` (the answer context looked sensitive and was dropped), `remember-rejected` (secret or sensitive identifier), `remember-duplicate` (the same statement was already written), `remember-dropped` (no normalised entry and the fallback is disabled), `remember-full` (the bounded outbox refused the write, so nothing was queued), `remember-unrequested` (a marker arrived on a turn that never passed the trigger), `remember-uncertain` / `remember-commit-pending` (see Boundaries), and `remember-timeout` (the host budget is too small for two requests). The reported byte count is capped at Magpie's 32768 limit.

## Enable capture and memory extraction

> **Neither write path is acceptance-tested in v0.2.0.** Capture (`POST /sessions/{id}/messages/batch`, the session `config` PATCH and server-side extraction) and remember (`.../messages/batch` plus `.../commit`) have only been checked against OpenViking's OpenAPI schema and a mock server; no live server has received either write from this plugin. Try them against a throwaway server/account first, then inspect the session (for example with `ov session ...`) before pointing them at real conversations. See [docs/verification.md](docs/verification.md).

Capture exports original human text and final visible assistant text to your configured OpenViking user. It omits injected memories, tool traffic, reasoning and image data. First enable it explicitly:

```sh
magpie plugin options magpie-openviking '{"enabled":true,"capture":true,"url":"http://127.0.0.1:1933","apiKeyEnv":"OPENVIKING_API_KEY","maxTokens":1200,"timeoutMs":1500,"gatewayTimeoutMs":3000}'
```

The plugin assigns a namespaced OV session and configures automatic commits at 20,000 pending tokens, more than 40 pending messages, or 600 seconds of inactivity. **The server must also enable its automatic commit scheduler** for idle extraction:

```json
{
  "memory": {
    "session_auto_commit": { "enabled": true }
  }
}
```

Merge this into your server configuration; do not replace the rest of your `ov.conf`. Consult the [v0.5.2 session API](https://github.com/volcengine/OpenViking/blob/v0.5.2/docs/en/api/05-sessions.md) for scheduler requirements. Saving raw messages alone does not imply that long-term memory has been extracted. `ov session commit <session-id>` is an alternative manual commit when automatic commits are disabled.

For final idle-turn capture and recovery of queued **unsent** exports, run the companion worker. Copy `examples/options.json` to a private file outside the repository, set `capture:true`, and use the same options/environment as Magpie:

```sh
node cli.mjs status /absolute/path/options.local.json
node cli.mjs flush /absolute/path/options.local.json
node cli.mjs flush /absolute/path/options.local.json --watch
```

The worker waits for 600 seconds of inactivity before exporting the last unacknowledged final answer. The server idle timer begins after it receives that turn, so last-turn extraction can take roughly both waiting periods plus processing time. Without the worker, the latest held candidate waits for another client request. Magpie's completion callback is best-effort: a reply whose notification never reached the plugin cannot be recovered by this worker.

## Explicit remember

> **Not acceptance-tested.** The remember write path — `POST /sessions/{id}/messages/batch`, `POST /sessions/{id}/commit` and server-side extraction — is verified against a mock server and the server's OpenAPI schema only. Try it against a throwaway account first, then inspect the session (for example with `ov session ...`).

Magpie hooks cannot register tools or run a second inference round, so remember is not a tool call. It is a deterministic trigger on the user's own message plus an ordinary two-request write in the completion callback, where the host timeout is independent of the finished reply.

```sh
magpie plugin options magpie-openviking '{"enabled":true,"remember":"command","url":"http://127.0.0.1:1933","apiKeyEnv":"OPENVIKING_API_KEY","maxTokens":1200,"timeoutMs":1500,"gatewayTimeoutMs":3000}'
```

| Trigger | Enabled by | Effect |
| --- | --- | --- |
| `/remember <text>` or `/记住 <text>` | `remember:"command"` | written at once, no confirmation |
| a bare `/remember` | `remember:"command"` | remembers the previous user message |
| anchored preference phrase (`以后都…`, `remember that…`) | `remember:"assisted"` | queues a candidate for `cli.mjs resolve … --approve` |
| `cli.mjs remember --text` | any non-`off` value | explicit write with no conversation state |

Only the user's own message can authorise a write; the model never decides whether one happens. The command must start the message, after optional whitespace: clients that prepend an environment notice *inside the same message* (some CLI agents) will not match, and the turn is treated as an ordinary question. A remember turn never recalls and is never also captured. Each statement is its own throw-away OpenViking session, scoped to the conversation that asked for it, committed with `keep_recent_count: 0`. Extraction therefore sees exactly that entry instead of an aggregated conversation, and two conversations can never append to one session.

Delivery has four states plus an `awaiting` flag: `awaiting` (the payload is not final — the model was asked to normalise it, or answer context is still missing — so it is never sent), `pending` (nothing attempted), `sent` (a crash interrupted the append: unknown, and never automatically committed or resent), `commit-pending` (append confirmed, only the commit failed) and `uncertain` (the append may have landed). Committing is reached only from `pending` or `commit-pending`, so an empty throw-away session can never be archived and reported as a successful write.

### Letting the model normalise the entry

With `rememberModel:"normalize"` the plugin appends **one English instruction** to the outgoing request — never to the client's history, so replay anchors stay byte-stable. The model rewrites the entry and ends its reply with a machine-readable marker; the plugin parses it, re-applies the same privacy filter, and falls back to the user's own words when the model does not comply (`rememberRawFallback`, default on).

The control instruction is English for every locale on purpose: one reviewed text instead of N translations. The entry itself keeps the user's language and is never translated, and the confirmation sentence is requested **in the language the user is using**.

| `rememberMarker` | Marker | Visible to the user? |
| --- | --- | --- |
| `comment` (default) | `<!-- openviking-remember … -->` | hidden where Markdown is rendered, visible in terminal clients |
| `line` | `/remember …` on the last line | always visible |

A marker is accepted only when that same turn already passed the deterministic trigger (`remember-unrequested` otherwise), so prompt injection that makes the model emit one cannot write memory. Tool-calling steps are parsed too, because a marker is not a final answer.

### Reviewing and reconciling

```sh
node cli.mjs remember /abs/options.local.json --text "…"   # explicit write, no conversation state
node cli.mjs review   /abs/options.local.json               # labels, statuses and ages only, never text
node cli.mjs resolve  /abs/options.local.json <event-id> --approve|--retry|--delivered
```

`--approve` releases a candidate that was never sent, `--retry` records a human judgement that an `uncertain` append did not land, `--delivered` records one that did. Approving a confirmed event and retrying a `commit-pending` one are refused with an explanation, because neither may trigger a second append. The CLI write itself requires a non-`off` `remember` mode, so the opt-in switch governs this path too, and it uses a fresh session per invocation.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` (no saved options) | Explicitly enable the integration. Separate from Magpie's per-plugin on/off toggle: both must be on. |
| `capture` | `false` | Explicitly export completed text turns. |
| `url` | `OPENVIKING_URL` or `http://127.0.0.1:1933` | OpenViking **Server** base URL. No embedded credentials, query or fragment. |
| `apiKeyEnv` | `OPENVIKING_API_KEY` | Name of the environment variable holding the personal key. |
| `maxTokens` | `1200` | Server recall budget, 64–8000; a heuristic budget, not billing tokens. |
| `contextType` | memory only | Set `all` to include accessible resources and skills too. |
| `timeoutMs` | `1500` | Upper bound for one API request, 100–9000 ms. The effective hook timeout is `min(timeoutMs, gatewayTimeoutMs - 200)`; the worker uses this value directly. |
| `gatewayTimeoutMs` | Magpie default: `1000` | Per-plugin option read by Magpie's hook host, not by this plugin, and not a global Magpie setting. Save `3000` or more for a full 1500 ms recall budget. A derived value below 500 ms is reported as `skipped`. |
| `stateDir` | `~/.local/state/magpie-openviking` | Private local replay/outbox directory; worker must use the same path. Environment override: `MAGPIE_OPENVIKING_STATE_DIR`. Removed by the worker and by an at-most-hourly lazy prune — see Boundaries. |
| `maxRecallChars` | `16000` | Oversized recall blocks are skipped, not cut through a rule/entry. Measured after wrapper-tag escaping. |
| `maxWindowChars` | `60000` | Total retained injection characters for the history currently being sent; records outside that history are pruned. |
| `maxCaptureChars` | `64000` | Oversized user+answer pairs are skipped rather than silently truncated. |
| `idleSeconds` | `600` | Final-candidate wait and OV idle commit policy, 300–86400. |
| `stateTtlDays` | `7` | Worker and lazy hook cleanup of idle replay states with no unresolved capture. |
| `remember` | `off` | `off`, `command` or `assisted`. Explicit opt-in, same as `capture`. |
| `rememberModel` | `off` | `normalize` asks the model to rewrite the entry (see above); `off` stores the user's words verbatim. |
| `rememberMarker` | `comment` | Machine-readable marker the model must emit: `comment` or `line`. |
| `rememberMaxChars` | `4000` | 256–8000. Oversized statements are rejected, never truncated. |
| `rememberTimeoutMs` | `1000` | Per request bound for the two remember calls, 200–9000. Derived for hooks as `min(x, max(200, (gatewayTimeoutMs-400)/2))`; below 400 ms the request reports `remember-timeout`. |
| `rememberRawFallback` | `true` | Store the user's own words when the model emits no usable entry. `false` drops the request (`remember-dropped`). |
| `rememberIncludeAnswer` | `false` | Also send the final answer of that turn as context. |
| `rememberCommands` | `["/remember","/记住"]` | Command prefixes, up to 8, no whitespace. Add your own language without code changes. |
| `rememberPatterns` | built-in zh/en list | Anchored regex sources for `assisted` candidates, up to 16. |

## Boundaries

- **Personal, direct loopback traffic only.** `remote`, `gateway-key`, missing/unknown origins, and missing session labels are untouched. A session label is never treated as authenticated user identity. Shared/remote gateways need explicit per-user credential binding and are outside v0.1.
- Responses requests using `previous_response_id` or server-managed `conversation` state are untouched. The plugin needs the complete visible history to replay reliably.
- Another `<openviking-context` in the request disables this integration for that request, avoiding double injection. Disable other automatic OV hooks when using this one. The wrapper is a presentation boundary, not a security boundary: recalled text is untrusted, matching wrapper tags are escaped before injection, but prompt injection remains possible.
- No client MCP tool registration, automatic Rule invocation, context compaction takeover or gateway-owned tool loop is implemented. Remember is deliberately a deterministic trigger plus a plain write, not a tool: the hook contract allows one inference request per client request.
- **`remembered` means archived and committed, not stored as a memory.** `POST /commit` archives synchronously and returns a `task_id`; extraction decides in the background which memories to create or update. Poll the task or inspect the session before claiming a memory exists.
- A remember event holds its statement on disk until it resolves (`awaiting`, `pending`, `sent`, `commit-pending`, `uncertain`). The per-turn classification keeps only the decision and the event id; the text is recomputed from the client history, so no second copy outlives the event. `sent` means a crash interrupted the append and the outcome is unknown: it is never committed or resent automatically. `commit-pending` retries the commit alone, which is a no-op when the throw-away session has nothing left to archive. Use `cli.mjs review` and `cli.mjs resolve` to reconcile by hand.
- Deduplication is conversation-local: the same statement remembered in two different conversations writes two events with two separate throw-away sessions.
- `rememberIncludeAnswer` is filtered like the statement itself: an answer that looks like it contains a secret is dropped from the payload (`remember-answer-omitted`) rather than persisted and exported.
- The visible marker is part of the assistant message the client keeps. If the user edits or removes it, that item changes and later turns in that conversation re-recall once.
- Model-driven triggering (`propose`) and an out-of-band extractor that decides *what* is worth remembering without any user phrase are **not implemented**. Until then the trigger vocabulary is explicit commands and anchored patterns, which is why the command list is configurable.
- Local replay states contain recalled private text. Opt-in capture additionally holds pending user/assistant text on disk. New files/directories use `0600`/`0700` **on POSIX**; Windows cannot set POSIX modes, so there the directory inherits the profile ACL instead. The plugin does not encrypt anything. Keep it outside Git, back it up only as private data, and use OS disk protection as needed.
- Expired idle state is deleted by the companion worker (`drain`) and by an at-most-hourly lazy prune at request time. States with a pending candidate or unresolved outbox entry are retained. Stop every process using the directory, then delete it, to start clean.
- One directory belongs to one host/worker installation. Exclusive per-state locks prevent concurrent modification. A crash can leave a `.lock`: run `node cli.mjs unlock [--force] [/absolute/path/options.local.json] [state-id]`, which lists lock owners and removes only locks whose recorded process is confirmed gone. `--force` is for another host or an unreadable owner (at least a minute old); a live process is never unlocked.
- A POST outcome marked `uncertain` requires reconciliation against the corresponding OV session before a human changes/removes the outbox entry. Do not blindly resend it. `status` prints labels (agent, cwd basename, hashed session prefix, protocol, created/last-used times) plus IDs/counts without displaying conversation text, so scope drift and pending ages are visible. Uncertain entries block later exports in that session and are retained, not silently discarded.
- Successful normal exports are locally deduplicated. This is not an exactly-once distributed delivery guarantee; losing local replay/outbox state loses that deduplication record.
- Resetting/compacting client history drops replay records whose anchors are no longer present; those turns re-recall once. The replay scope itself is keyed by agent, working directory, session and protocol, so a rewritten system notice no longer creates a second state or OV session. Editing content that was already exported cannot retract existing OV memories.

## Credits

- **Development:** 开放维京特工@飞书, a Feishu agent that designed and implemented this integration.
- **Maintenance, releases and issues:** [@MengXiangxi](https://github.com/MengXiangxi).

Repository topics include `magpie-plugin`, which is how Magpie discovers community plugins on GitHub. A topic is not a review, an endorsement or a guarantee that an older Magpie build supports these hooks.

## References

- [Magpie async gateway hook contract](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md)
- [Magpie plugin documentation and GitHub-topic discovery](https://usemagpie.ai/docs/plugins)
- [OpenViking v0.5.2 context retrieval API](https://github.com/volcengine/OpenViking/blob/v0.5.2/docs/en/api/06-retrieval.md)
- [OpenViking v0.5.2 sessions API](https://github.com/volcengine/OpenViking/blob/v0.5.2/docs/en/api/05-sessions.md)
