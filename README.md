# magpie-openviking

[中文说明](README.zh-CN.md) · MIT · Experimental v0.1.0

Developed by **开放维京特工@飞书** (a Feishu agent) · maintained by **[MengXiangxi](https://github.com/MengXiangxi)**.

**Status:** recall is verified live against a Magpie hook host and an OpenViking Server v0.4.22. Capture is implemented and schema-checked but **not yet acceptance-tested against a live server** — see [docs/verification.md](docs/verification.md).

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
- Local transport outbox. An append with an uncertain outcome is **not** automatically resent: OpenViking `source_message_ids` are provenance, not idempotency keys.
- No runtime npm dependencies and no hidden model/tool execution loop.

This is an independent community integration, not an official Magpie or OpenViking plugin.

## Requirements and verification scope

- A Magpie build with `magpie.hooks`, async `onRequest`/`onResponse`, `ctx.origin`, and private request `ctx.state`. Older synchronous JS middleware alone is insufficient. See [Magpie's contract](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md).
- A per-plugin `gatewayTimeoutMs` of **3000 ms or more**. Magpie's hook host defaults to 1000 ms per hook, which is *below* this plugin's own `timeoutMs` default of 1500 ms, so on default timing every recall is aborted and nothing is injected (fail open, hard to notice). `gatewayTimeoutMs` is a per-plugin option read by Magpie's host, not a global Magpie setting, and Magpie's `package.json` `magpie.options` block is only a printed suggestion.
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

Pin the release instead of tracking the default branch with `github:MengXiangxi/magpie-openviking#v0.1.0`; `magpie plugin update magpie-openviking` moves an unpinned install forward. There is no npm publication and no build step.

For local development, install the checkout in place instead. Run `npm run check` and `npm test` (or `npm run test:bun`) first, then:

```sh
magpie plugin add /absolute/path/to/magpie-openviking
```

Set `OPENVIKING_API_KEY` using your operating system's environment/secret facilities **before starting Magpie**, then restart Magpie so its Bun host inherits it. A shell export does not necessarily reach a desktop application launched from a menu. Never put the secret in this repository, plugin options, an issue or a chat. Options contain the **environment variable name**, not its value.

The `magpie plugin options` line above is **not optional**: `package.json`'s `magpie.options` block is only a suggestion that `magpie plugin options <name>` prints, and Magpie never applies it by itself. There are also two independent switches — Magpie's per-plugin on/off toggle and `enabled` in these options. Both must be on; a plugin switched on in the GUI with no saved options reports `skipped`.

A folder install is loaded in place, so keep the folder present and change options or toggle the plugin to pick up source edits. A GitHub install is a clone Magpie keeps and refreshes itself. An npm install/build step is unnecessary in both cases.

Start a new complete-history chat. Magpie's Plugins page should report `ready` or `empty`. `unbound` usually means the credential/session is absent, or the request is not classified as a direct local request.

## Enable capture and memory extraction

> **Capture is not acceptance-tested in v0.1.0.** The write path — `POST /sessions/{id}/messages/batch`, the session `config` PATCH and server-side extraction — has only been checked against OpenViking's OpenAPI schema; no live server has received a captured turn from this plugin. Try it against a throwaway server/account first, then inspect the session (for example with `ov session ...`) before pointing it at real conversations. See [docs/verification.md](docs/verification.md).

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

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` (no saved options) | Explicitly enable the integration. Separate from Magpie's per-plugin on/off toggle: both must be on. |
| `capture` | `false` | Explicitly export completed text turns. |
| `url` | `OPENVIKING_URL` or `http://127.0.0.1:1933` | OpenViking **Server** base URL. No embedded credentials, query or fragment. |
| `apiKeyEnv` | `OPENVIKING_API_KEY` | Name of the environment variable holding the personal key. |
| `maxTokens` | `1200` | Server recall budget, 64–8000; a heuristic budget, not billing tokens. |
| `contextType` | memory only | Set `all` to include accessible resources and skills too. |
| `timeoutMs` | `1500` | Per-API-request timeout, 100–9000 ms. Keep below Magpie's per-hook `gatewayTimeoutMs`, or the host aborts the hook first. |
| `gatewayTimeoutMs` | Magpie default: `1000` | Per-plugin option read by Magpie's hook host, not by this plugin, and not a global Magpie setting. Save `3000` or more in plugin options; otherwise recall is aborted at 1000 ms. |
| `stateDir` | `~/.local/state/magpie-openviking` | Private local replay/outbox directory; worker must use the same path. Environment override: `MAGPIE_OPENVIKING_STATE_DIR`. Only the worker prunes it — see Boundaries. |
| `maxRecallChars` | `16000` | Oversized recall blocks are skipped, not cut through a rule/entry. |
| `maxWindowChars` | `60000` | Total retained injection characters in one history; existing blocks remain stable. |
| `maxCaptureChars` | `64000` | Oversized user+answer pairs are skipped rather than silently truncated. |
| `idleSeconds` | `600` | Final-candidate wait and OV idle commit policy, 300–86400. |
| `stateTtlDays` | `7` | Worker cleanup of idle replay states with no unresolved capture. |

## Boundaries

- **Personal, direct loopback traffic only.** `remote`, `gateway-key`, missing/unknown origins, and missing session labels are untouched. A session label is never treated as authenticated user identity. Shared/remote gateways need explicit per-user credential binding and are outside v0.1.
- Responses requests using `previous_response_id` or server-managed `conversation` state are untouched. The plugin needs the complete visible history to replay reliably.
- Another `<openviking-context` in the request disables this integration for that request, avoiding double injection. Disable other automatic OV hooks when using this one.
- No client MCP tool registration, automatic Rule invocation, context compaction takeover or gateway-owned tool loop is implemented.
- Local replay states contain recalled private text. Opt-in capture additionally holds pending user/assistant text on disk. New files/directories use `0600`/`0700` **on POSIX**; Windows cannot set POSIX modes, so there the directory inherits the profile ACL instead. The plugin does not encrypt anything. Keep it outside Git, back it up only as private data, and use OS disk protection as needed.
- Expired state is only deleted by the companion worker (`drain`). If you never run it, `stateDir` grows with one file per replay scope and nothing is pruned. Stop every process using the directory, then delete it, to start clean.
- One directory belongs to one host/worker installation. Exclusive per-state locks prevent concurrent modification. A crash can leave a `.lock`: stop **all** processes using the directory before inspecting/removing a stale lock; the plugin never steals one from a live writer.
- A POST outcome marked `uncertain` requires reconciliation against the corresponding OV session before a human changes/removes the outbox entry. Do not blindly resend it. `status` lists IDs/counts without displaying conversation text. Uncertain entries block later exports in that session and are retained, not silently discarded.
- Successful normal exports are locally deduplicated. This is not an exactly-once distributed delivery guarantee; losing local replay/outbox state loses that deduplication record.
- Resetting/compacting client history creates a fresh replay scope. Editing content that was already exported cannot retract existing OV memories.

## Credits

- **Development:** 开放维京特工@飞书, a Feishu agent that designed and implemented this integration.
- **Maintenance, releases and issues:** [@MengXiangxi](https://github.com/MengXiangxi).

Repository topics include `magpie-plugin`, which is how Magpie discovers community plugins on GitHub. A topic is not a review, an endorsement or a guarantee that an older Magpie build supports these hooks.

## References

- [Magpie async gateway hook contract](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-request-hooks.md)
- [Magpie plugin documentation and GitHub-topic discovery](https://usemagpie.ai/docs/plugins)
- [OpenViking v0.5.2 context retrieval API](https://github.com/volcengine/OpenViking/blob/v0.5.2/docs/en/api/06-retrieval.md)
- [OpenViking v0.5.2 sessions API](https://github.com/volcengine/OpenViking/blob/v0.5.2/docs/en/api/05-sessions.md)
