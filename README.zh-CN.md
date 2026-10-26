# magpie-openviking

[English](README.md) · MIT · 实验版 v0.1.0

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
- 零运行时 npm 依赖，MIT 开源。属于独立社区项目，不代表两边官方发布。

## 安装与首次验证

需要支持 `magpie.hooks`、异步 `onRequest/onResponse`、`ctx.origin` 的 Magpie 版本，以及带上下文检索和会话 API 的 OV Server。本项目按 OV v0.5.2 文档实现，并在 v0.4.22 上实测（用到的字段两边都接受）。插件实际由 Magpie 的 Bun 宿主运行（仓库内的 Node.js 22+ 只用于测试和 worker）。

**必须把 `gatewayTimeoutMs` 设为 3000 或更大。** Magpie 每个 hook 默认只有 1000 ms，比本插件自己的 `timeoutMs` 默认值 1500 ms 还短，按默认值跑等于每次召回都被宿主打断（fail open，表面上什么都正常，只是永远没有记忆）。注意它是**给 Magpie 宿主读的插件选项**，不是全局设置；而 `package.json` 里的 `magpie.options` 只是「建议值」，Magpie 不会自动套用。

安装后**必须真的存一次选项**（下面第二条命令，或在插件页保存同样的 JSON）。Magpie 插件页的开关和选项里的 `enabled` 是**两道独立的开关**，只开页面上那个、没有存选项时，插件状态会是 `skipped`。

从 GitHub 安装，然后把选项存一次：

```sh
magpie plugin add github:MengXiangxi/magpie-openviking
magpie plugin options magpie-openviking '{"enabled":true,"capture":false,"url":"http://127.0.0.1:1933","apiKeyEnv":"OPENVIKING_API_KEY","maxTokens":1200,"timeoutMs":1500,"gatewayTimeoutMs":3000}'
```

想钉住某个版本而不是跟随主分支，用 `github:MengXiangxi/magpie-openviking#v0.1.0`；不钉版本的安装用 `magpie plugin update magpie-openviking` 升级。没有 npm 发布，也不需要构建。

本地开发时改为目录安装：先在源码目录跑 `npm run check` 和 `npm test`（或 `npm run test:bun`），然后：

```sh
magpie plugin add /absolute/path/to/magpie-openviking
```

在启动 Magpie 前，通过操作系统环境或自己的凭据管理方式设置 `OPENVIKING_API_KEY`。使用个人 User/Admin Key，不使用 Root Key。桌面菜单启动的应用未必继承终端的 export，设置后需重启 Magpie。插件选项里只写环境变量**名称**，不要写 Key 本身。

目录安装是就地加载，要保留原目录，改源码后切换插件或改选项即可重载；GitHub 安装是 Magpie 自己维护的一份克隆，用 `magpie plugin update` 刷新。两种情况都不需要 npm install 或构建。新开一个完整历史会话，在 Magpie 插件页观察 `ready/empty`；`unbound` 表示身份、会话或环境配置不足。

## 开启记忆写入

> **v0.1.0 的写入路径尚未验收。** `POST /sessions/{id}/messages/batch`、会话 `config` PATCH 和服务端记忆抽取只做过 OpenAPI schema 对照，没有任何真实服务器收到过本插件写入的回合。请先用一次性服务器/账号试，用 `ov session ...` 检查会话内容无误后再接到真实对话上。详见 [docs/verification.md](docs/verification.md)。

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

## 使用范围

- 首版只支持单人直连本机的请求。共享 Key、远程、转发或无法确认来源的请求保持原样，不将会话标签当作用户身份。
- Responses 的 `previous_response_id` 或服务端 `conversation` 模式跳过，需要完整历史才能稳定回放。
- 检测到已有 `<openviking-context` 时跳过，避免与现有 OV 插件重复注入。
- 未实现 MCP 工具注册、自动 Rule 调用、上下文压缩接管或隐藏工具执行循环。
- 新状态文件在 POSIX 上使用 0600、目录 0700；**Windows 无法设置 POSIX 权限位**，只能依赖用户目录 ACL。召回文本、待发送对话保存在本地私有状态目录中，插件本身不加密，请勿上传 GitHub。完整选项和数据说明见 [英文 README](README.md)。
- **只有 worker 会清理过期状态**。不跑 worker 时，状态目录会随着会话数一直增长（每个会话一个文件，最多 512 条回放记录）。要清空请先停掉所有使用该目录的宿主与 worker，再删除目录。
- 请求超时/检索失败时保留主请求；缓存命中和延迟收益需要真实环境验证，没有宣称性能提高比例。
- `uncertain` 表示消息写入结果不确定，该会话后续导出暂停。须先检查 OV 对应会话再人工处理本地条目，不要直接重发。`source_message_ids` 是来源信息，不是服务端幂等键。
- 进程异常退出可能留下 `.lock`。先停止所有使用该目录的宿主/worker，再检查并清除陈旧锁；运行中的锁不能删除。

## 开发与维护

- **开发：** 开放维京特工@飞书（飞书智能体）。
- **维护、发布与 issue 处理：** [@MengXiangxi](https://github.com/MengXiangxi)。

仓库 topics 里带 `magpie-plugin`，Magpie 靠这个 topic 在 GitHub 上发现社区插件。topic 只是发现入口，不代表审核或背书，旧版本 Magpie 是否支持这组 Hook 要单独确认。完整技术契约、选项和参考链接见 [英文 README](README.md)。

## 验证范围

提供协议单元测试和真实本地 HTTP mock 集成测试（Node 22 与 Bun 1.4.4 均为 22/22 通过），覆盖回放、重试、超时、身份隔离、确认后捕获、重新生成、空闲处理和不确定写入；召回已在真实 Magpie + OpenViking v0.4.22 上验证，**写入路径尚未验收**。GitHub Actions 在 Linux/macOS/Windows、Node 22/24 与 Bun 上跑同一套测试。
