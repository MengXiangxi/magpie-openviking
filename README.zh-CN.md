# magpie-openviking

[English](README.md) · MIT · 实验版 v0.2.0

由 **开放维京特工@飞书**（飞书智能体）开发 · 由 **[MengXiangxi](https://github.com/MengXiangxi)** 维护。

**状态：** 召回已在真实 Magpie hook 宿主 + OpenViking Server v0.4.22 上跑通；**写入（capture）只做过接口 schema 对照，还没有任何一次真实写入验收**，详见 [docs/verification.md](docs/verification.md)。

把 OpenViking 记忆召回放到 Magpie 的**异步网关 Hook**中。模型请求仍由 Magpie 直接发给上游，旁路调用 OpenViking Server 的检索和会话 API，不需要再串一个 OV 模型网关。

```text
Agent → Magpie + 本插件 → 模型服务商
                ↕
        OpenViking Server
        检索、保存、后台记忆提取
```

## 已实现

- 自动检索记忆并追加到最新用户消息，旧注入内容持久化后逐轮原样回放。
- 重试复用同一份结果，工具步骤只回放，不重复检索。
- 支持 Chat Completions、Anthropic Messages、完整历史的 Responses、Gemini；保留客户端工具、图片、思考内容、模型和流式设置。
- 对话捕获默认关闭，开启后只保存原始用户文本和最终可见回答，不保存注入内容、工具流量、思考或图片。
- 回答先暂存，后续客户端历史确认保留后才入队；重新生成会替换尚未确认的回答。
- 可选 worker 处理最后一个空闲回合和已入队的未发送内容。发送结果不确定时停止重发，避免盲目重复写入。
- 可选**显式记忆写入**：用户自己消息里的 `/remember`、`/记住` 指令（或 `assisted` 模式的固定句式）会写一个一次性会话并提交抽取。由规则决定“是否写”，模型最多只决定“写什么”。
- 零运行时 npm 依赖，MIT 开源。属于独立社区项目，不代表两边官方发布。

## 安装与首次验证

需要支持 `magpie.hooks`、异步 `onRequest/onResponse`、`ctx.origin` 的 Magpie 版本，以及带上下文检索和会话 API 的 OV Server。本项目按 OV v0.5.2 文档实现，并在 v0.4.22 上实测（用到的字段两边都接受）。插件实际由 Magpie 的 Bun 宿主运行（仓库内的 Node.js 22+ 只用于测试和 worker）。

**建议把 `gatewayTimeoutMs` 设为 3000 或更大。** 插件现在按 `min(timeoutMs, gatewayTimeoutMs - 200)` 推导实际超时，Magpie 默认的 1000 ms 会得到 800 ms 召回预算，而不是必然被宿主打断；推导结果低于 500 ms 时状态会报 `skipped`。注意它是**给 Magpie 宿主读的插件选项**，不是全局设置；而 `package.json` 里的 `magpie.options` 只是「建议值」，Magpie 不会自动套用。

安装后**必须真的存一次选项**（下面第二条命令，或在插件页保存同样的 JSON）。Magpie 插件页的开关和选项里的 `enabled` 是**两道独立的开关**，只开页面上那个、没有存选项时，插件状态会是 `skipped`。

从 GitHub 安装，然后把选项存一次：

```sh
magpie plugin add github:MengXiangxi/magpie-openviking
magpie plugin options magpie-openviking '{"enabled":true,"capture":false,"url":"http://127.0.0.1:1933","apiKeyEnv":"OPENVIKING_API_KEY","maxTokens":1200,"timeoutMs":1500,"gatewayTimeoutMs":3000}'
```

想钉住某个版本而不是跟随主分支，用 `github:MengXiangxi/magpie-openviking#v0.2.0`；不钉版本的安装用 `magpie plugin update magpie-openviking` 升级。没有 npm 发布，也不需要构建。从 v0.1.x 升级不需要迁移：`remember` 默认 `off`，状态文件在首次加载时自动补齐回执列表。见 [CHANGELOG.md](CHANGELOG.md)。

本地开发时改为目录安装：先在源码目录跑 `npm run check` 和 `npm test`（或 `npm run test:bun`），然后：

```sh
magpie plugin add /absolute/path/to/magpie-openviking
```

在启动 Magpie 前，通过操作系统环境或自己的凭据管理方式设置 `OPENVIKING_API_KEY`。使用个人 User/Admin Key，不使用 Root Key。桌面菜单启动的应用未必继承终端的 export，设置后需重启 Magpie。插件选项里只写环境变量**名称**，不要写 Key 本身。

目录安装是就地加载，要保留原目录，改源码后切换插件或改选项即可重载；GitHub 安装是 Magpie 自己维护的一份克隆，用 `magpie plugin update` 刷新。两种情况都不需要 npm install 或构建。新开一个完整历史会话，在 Magpie 插件页观察 `ready/empty`；`unbound` 表示身份、会话或环境配置不足。

状态码：`ready`（已注入）、`empty`（检索无结果）、`skipped`（选项/预算/查询不适用）、`unbound`（缺少凭据、会话或来源）、`unavailable`（超时、网络或 5xx）、`unauthorized`（401/403）、`invalid`（其他 4xx 或响应格式错误）、`mismatch`（暂存回答未在后继历史中复现；召回不受影响）。上报字节数上限为 Magpie 的 32768。

## 开启记忆写入

> **v0.2.0 的两条写入路径都没有验收。** 捕获（`POST /sessions/{id}/messages/batch`、会话 `config` PATCH、服务端记忆抽取）与显式写入（`.../messages/batch` + `.../commit`）都只做过 OpenAPI schema 对照和 mock server 测试，没有任何真实服务器收到过本插件的写入。请先用一次性服务器/账号试，用 `ov session ...` 检查会话内容无误后再接到真实对话上。详见 [docs/verification.md](docs/verification.md)。

把插件选项改为 `capture:true`，其余保持一致。插件按独立命名空间创建 OV 会话，设置 20,000 pending token、超过 40 条 pending 消息或空闲 600 秒的自动提交策略。要让最后一种条件生效，**OV 服务端还必须开启自动提交调度器**：

```json
{"memory":{"session_auto_commit":{"enabled":true}}}
```

将字段合并到已有配置，不要覆盖整个 `ov.conf`。也可关闭自动提交，按需运行 `ov session commit <session-id>`。保存了原始消息不代表已经完成长期记忆提取。

把 `examples/options.json` 复制到仓库之外的私有文件，设置 `capture:true`，确保与插件使用相同 URL、Key 环境变量和状态目录，然后运行：

```sh
node cli.mjs status /absolute/path/options.local.json
node cli.mjs flush /absolute/path/options.local.json
node cli.mjs flush /absolute/path/options.local.json --watch
```

worker 在 600 秒空闲后上传最后一个暂存回答；OV 收到消息后才开始自己的空闲计时，因此最后一轮提取可能需要两个等待周期加处理时间。不跑 worker 时，最后一轮等待下一次客户端请求确认。Magpie 完成通知本身是尽力投递，未到达本插件的通知无法凭空恢复。

## 显式记忆写入（remember）

> **尚未在真实服务端验收。** 写入路径（`POST /sessions/{id}/messages/batch`、`POST /sessions/{id}/commit` 和服务端抽取）只对 mock server 与 OpenAPI schema 做过核对。请先用一次性账号试，再用 `ov session ...` 检查会话。

Magpie 的 Hook 不能注册工具、也不能跑第二轮推理，所以 remember 不是工具调用，而是“用户自己消息上的确定性触发 + 完成回调里的两次普通写入”。完成回调有独立于已结束请求的超时信号，因此不占用户看到的回复延迟。

```sh
magpie plugin options magpie-openviking '{"enabled":true,"remember":"command","url":"http://127.0.0.1:1933","apiKeyEnv":"OPENVIKING_API_KEY","maxTokens":1200,"timeoutMs":1500,"gatewayTimeoutMs":3000}'
```

| 触发 | 开启方式 | 行为 |
| --- | --- | --- |
| `/remember 文本` 或 `/记住 文本` | `remember:"command"` | 直接写入，不需确认 |
| 单独一个 `/remember` | `remember:"command"` | 记住上一条用户消息 |
| 固定句式（`以后都…`、`记住：…`） | `remember:"assisted"` | 只入队为候选，需 `cli.mjs resolve … --approve` |
| `cli.mjs remember --text` | 任意非 `off` 值 | 不依赖会话状态的显式写入 |

只有用户自己的消息能授权写入，模型永远不决定“是否写”。remember 回合既不召回，也不会被对话捕获重复写入。每条语句使用独立的一次性会话（`magpie-remember-…`），以 `keep_recent_count: 0` 提交，抽取范围就只有这一条。

### 让模型规范化内容

设置 `rememberModel:"normalize"` 后，插件只往**发往上游的请求**里追加一段**英文**指令（不进入客户端历史，回放锚点保持字节稳定）。模型改写后的条目放在回复末尾的机读标记里，插件解析后再过一次同样的隐私检查；模型不配合时回退到用户原话（`rememberRawFallback`，默认开启）。

控制指令固定用英文，是为了一种文案适配所有语言；条目本身保持用户原语言、不翻译，而“已提交”那句话要求模型**用用户当前语言**说。

| `rememberMarker` | 标记形式 | 用户可见性 |
| --- | --- | --- |
| `comment`（默认） | `<!-- openviking-remember … -->` | Markdown 渲染下不可见，终端客户端可见 |
| `line` | 末行 `/remember …` | 始终可见 |

标记只在**同一轮已通过确定性触发**时才被接受（否则报 `remember-unrequested`），因此即使提示注入让模型吐出标记，也写不进记忆。工具调用中间步骤同样会被解析，因为标记不等于最终回答。

### 复核与协调

```sh
node cli.mjs remember /abs/options.local.json --text "…"   # 显式写入，不建会话状态
node cli.mjs review   /abs/options.local.json               # 只列标签/状态/时长，不打印正文
node cli.mjs resolve  /abs/options.local.json <event-id> --approve|--retry|--delivered
```

`--approve` 放行候选，`--retry` 表示人工确认“未写入、可重试”，`--delivered` 表示确认“已写入”。插件自己永不改变这两种状态：`sent` 不自动重发，`commit-pending` 只重试 commit。

## 使用范围

- 首版只支持单人直连本机的请求。共享 Key、远程、转发或无法确认来源的请求保持原样，不将会话标签当作用户身份。
- Responses 的 `previous_response_id` 或服务端 `conversation` 模式跳过，需要完整历史才能稳定回放。
- 检测到已有 `<openviking-context` 时跳过，避免与现有 OV 插件重复注入。包装标记只是展示边界，不是安全边界：召回文本属于不可信内容，匹配的包装标签会在注入前转义，但仍无法消除提示注入风险。
- 未实现 MCP 工具注册、自动 Rule 调用、上下文压缩接管或隐藏工具执行循环。remember 是“确定性触发 + 普通写入”，不是工具：契约限制为一次客户端请求一次推理。
- **`remembered` 只代表“已归档 + 已提交抽取任务”**。`POST /commit` 同步完成归档并返回 `task_id`，后台才决定创建/更新哪些记忆。不要据此向用户宣称“已经记住了”。
- remember 事件在解决前会在本地保存语句原文（`pending`/`sent`/`commit-pending`/`uncertain`）。`sent` 表示 append 结果未知，永不自动重发；`commit-pending` 只重试 commit（一次性会话无可归档内容时为 no-op）。用 `cli.mjs review` / `cli.mjs resolve` 人工协调。
- 可见标记会留在客户端保存的助手消息里。用户删改它就会改变该条消息，导致该会话后续轮次重新召回一次。
- **模型自主触发（`propose`）和带外抽取器（不靠用户句式决定“值不值得记”）尚未实现。** 目前触发词是显式指令加固定句式，所以指令表可配置。
- 新状态文件在 POSIX 上使用 0600、目录 0700；**Windows 无法设置 POSIX 权限位**，只能依赖用户目录 ACL。召回文本、待发送对话保存在本地私有状态目录中，插件本身不加密，请勿上传 GitHub。完整选项和数据说明见 [英文 README](README.md)。
- **worker 与请求路径上每小时最多一次的惰性清理会删除过期状态。** 有暂存回答或未解决 outbox 条目的状态会保留。要清空请先停掉所有使用该目录的宿主与 worker，再删除目录。
- 请求超时/检索失败时保留主请求；缓存命中和延迟收益需要真实环境验证，没有宣称性能提高比例。
- `uncertain` 表示消息写入结果不确定，该会话后续导出暂停。须先检查 OV 对应会话再人工处理本地条目，不要直接重发。`source_message_ids` 是来源信息，不是服务端幂等键。`status` 会显示 agent、cwd 目录名、会话哈希前缀、协议和创建/最近使用时间，便于发现作用域漂移。
- 进程异常退出可能留下 `.lock`。运行 `node cli.mjs unlock [--force] [/absolute/path/options.local.json] [state-id]` 可列出锁持有者，并只删除确认已退出的本机进程留下的锁；活进程的锁永远不会被删除，`--force` 仅用于其他主机或无法读取持有者的锁。

## 开发与维护

- **开发：** 开放维京特工@飞书（飞书智能体）。
- **维护、发布与 issue 处理：** [@MengXiangxi](https://github.com/MengXiangxi)。

仓库 topics 里带 `magpie-plugin`，Magpie 靠这个 topic 在 GitHub 上发现社区插件。topic 只是发现入口，不代表审核或背书，旧版本 Magpie 是否支持这组 Hook 要单独确认。完整技术契约、选项和参考链接见 [英文 README](README.md)。

## 验证范围

提供协议单元测试和真实本地 HTTP mock 集成测试（Node 与 Bun 均 59/59 通过），覆盖回放裁剪、重试、超时推导、身份隔离、确认后捕获、重新生成、空闲处理、锁回收、不确定写入，以及 remember 的命令/句式识别、隐私过滤、模型规范化与回退、去重、与捕获互斥、commit 单独重试。召回已在真实 Magpie + OpenViking v0.4.22 上验证，**捕获与 remember 的写入路径尚未在真实服务端验收**。GitHub Actions 在 Linux/macOS/Windows、Node 22/24 与 Bun 上跑同一套测试。
