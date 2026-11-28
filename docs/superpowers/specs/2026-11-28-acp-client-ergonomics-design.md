# ACP 宿主易用性(TransOnce 反馈)— 设计

日期:2026-11-28 · 状态:设计已确认(来源:TransOnce 按优先级提的 6 条,本轮做 1-4,5/6 记账延后)

## 意图

下游宿主 TransOnce 反馈的接入摩擦:模型枚举要起完整会话、选错模型静默回退、取消/退出行为不明确、stderr 诊断不可机读。本轮补齐四件小事,让宿主 UI 稳定可信。

## 设计

### 1. 廉价模型枚举

- **ACP 扩展方法 `agent/models`**:免 initialize 会话语义之外的任何状态,直接返回 `{ models: Array<{ modelId: string; name: string }> }`,内容与 `getAvailableModels()` 一致(注册表厂商 id)。
- **CLI 子命令 `transcode models`**:stdout 输出一行 JSON,同上数组;退出码 0。帮助文本补一行。

### 2. session/new 的 model 校验

- `src/provider/provider.ts` 新增 `validateModelSpec(spec: string): string | null`——返回 null 为合法,否则错误消息。合法定义:注册表 id(`glm`/`glmc`/…)、用户 profile 名(`~/.transcode.json` profiles)、`<已知前缀>:<model>`(前缀 ∈ 注册表 id ∪ `openai`/`anthropic` 等 PROVIDER_DEFAULTS 键)。**模型名本身不校验**(厂商目录会过期;前缀级校验抓住 typo 真凶)。
- `session/new` 收到 `params.model` 非法时:RpcError `invalidParams`(`invalid model id: <spec>`,可用模型见 agent/models),同时 stderr 写 `error: invalid model id: <spec>`。**不再静默回退**——UI 显示 A 就跑 A。
- 行为变化在 `docs/ACP.md` 写明。

### 3. 取消与退出

- `session/cancel` 已存在(request+notification),文档已载——无需改动,向 TransOnce 说明即可。
- SIGTERM/SIGINT 退出路径补一行 stderr:`[transcode] SIGTERM: shutting down`(SIGINT 同理),随后照旧尽快 `exit(0)`。(今日卡死为 0.12.17 已修的标题调用挂死 finally。)

### 4. stderr 机器可读诊断

- 约定:**错误类事件在 stderr 输出一行 `error: <message>`**(前缀恰为 `error: `)。
- 落点:`AcpServer.handleRequest` 的异常路径统一写该方法处理失败时写 RpcError 同消息;session/new 校验失败(设计 2)是首个实例。宿主 grep `^error: ` 透传用户。

## 非目标

- 结构化输出(JSON mode)与 ping/心跳——记账延后。
- `agent/models` 的分页/过滤(目录就 7 条)。

## 验收口径

- `initialize` 后直接 `agent/models` 返回目录,无需 session/new。
- `transcode models` stdout 一行合法 JSON,`jq` 可解析。
- `session/new {model: "glmz:x"}` → invalidParams 错误帧 + stderr 含 `error: invalid model id`;`{model: "glmc:glm-5.3-flash"}` 照常创建。
- SIGTERM 后 stderr 有退出原因行,进程即刻退出。
