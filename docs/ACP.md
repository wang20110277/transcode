# transcode ACP 协议说明

transcode 实现了 [Agent Client Protocol (ACP) v1](https://agentclientprotocol.com/) 的最小子集，通过 stdin/stdout 上的换行分隔 JSON-RPC 2.0 通信。transonce、multica 等客户端可以把 transcode 当作一个本地 ACP runtime 启动。

## 启动

```bash
transcode acp
# 或
bun bin/transcode.ts acp
```

约束：

- stdout **只**输出 JSON-RPC 帧，一行一个。
- 日志、警告、第三方库的 `console.log` 全部重定向到 stderr。
- 进程在 stdin 关闭或收到 SIGINT/SIGTERM 时退出。

## 方法

### 客户端 → Agent

| 方法 | 说明 |
| --- | --- |
| `initialize` | 握手，返回协议版本和能力 |
| `authenticate` | MVP 恒返回 `null`（不要求认证） |
| `session/new` | 创建进程内 session，返回 `sessionId` 和模型列表 |
| `session/prompt` | 执行一个 turn，流式发送 `session/update`，最后返回 `stopReason` |
| `session/set_model` | 切换后续 turn 使用的模型 |
| `session/cancel` | 取消当前 turn（也支持作为 notification） |
| `session/load` / `session/resume` | 进程内命中返回同一 session；否则从 `~/.transcode/sessions` 磁盘恢复（重启后续问），仍无 `-32002` |
| `session/list` | transcode 扩展：按 `cwd` 返回该项目磁盘会话（`sessionId`/`title`/`updatedAt`，新→旧） |
| `session/close` | 关闭活跃 session（磁盘记录保留，可再 `load`） |
| `session/set_config_option` | MVP 接受但忽略 |
| `session/request_permission` | **Agent → 客户端** 的请求，见下文 |

`initialize` 返回：

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "transcode", "version": "0.1.0" },
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "mcpCapabilities": { "http": false, "sse": false }
  },
  "authMethods": []
}
```

`session/new` 参数：

```json
{
  "cwd": "/absolute/task/workspace",
  "mcpServers": [],
  "model": "deepseek"
}
```

`model` 可省略，省略时使用 `TRANSCODE_MODEL` 或默认 `opus`。`mcpServers` 在 MVP 中会被忽略（stderr 提示）。

返回：

```json
{
  "sessionId": "ses_...",
  "models": {
    "availableModels": [
      { "modelId": "opus", "name": "Claude Opus" },
      { "modelId": "gpt", "name": "GPT-4o" }
    ],
    "currentModelId": "deepseek"
  }
}
```

### `session/prompt`

请求：

```json
{
  "sessionId": "ses_...",
  "prompt": [{ "type": "text", "text": "修复这个测试失败" }]
}
```

响应：

```json
{ "stopReason": "end_turn" }
```

`stopReason` 取值：`end_turn`、`max_turn_requests`、`refusal`、`cancelled`。

同一个 session 同时只处理一个 prompt；并发调用返回 `-32000`。

## 流式事件

所有事件都是 `session/update` notification：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "ses_...",
    "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "..." } }
  }
}
```

支持的事件：

| `sessionUpdate` | 说明 |
| --- | --- |
| `agent_message_chunk` | 助手文本增量 |
| `agent_thought_chunk` | 思考增量（MVP 模型暂不产生） |
| `tool_call` | 工具开始：`toolCallId`、`name`、`title`、`kind`、`status: "pending"`、`rawInput` |
| `tool_call_update` | 工具结束：`toolCallId`、`status: "completed" \| "failed"`、`content` |

工具标题使用 ACP 常见前缀，便于 transonce / multica 等客户端映射：

- `terminal: <command>`
- `read: <path>`
- `write: <path>`
- `patch: <path>`
- `search: <pattern>`

工具结果示例：

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call_1",
  "status": "completed",
  "name": "bash",
  "content": [
    { "type": "content", "content": { "type": "text", "text": "hello\n\n[exit] code=0" } }
  ]
}
```

## 权限流程

写文件、改文件、执行 bash 在默认 `ask` 模式下会触发：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session/request_permission",
  "params": {
    "sessionId": "ses_...",
    "toolCall": {
      "toolCallId": "call_1",
      "title": "terminal: rm -rf build",
      "kind": "execute",
      "status": "pending",
      "rawInput": { "command": "rm -rf build" }
    },
    "options": [
      { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
      { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" }
    ]
  }
}
```

客户端选择允许：

```json
{ "jsonrpc": "2.0", "id": 7, "result": { "outcome": { "outcome": "selected", "optionId": "allow_once" } } }
```

选择拒绝或 `{"outcome":{"outcome":"cancelled"}}` 都会让工具返回失败，但不会中断整个 turn。

`allow_always` 允许这一次，并在本会话内记住归纳出的一类调用（如 `bash(npm test*)`），之后同类调用不再请求。`reject_always` 拒绝，并把这一类记成拒绝。因为配置里的 `ask` 规则而发出的请求只有「允许一次」和「拒绝」两个选项。

配置里的权限规则（`~/.transcode.json` 的 `permissions`，写法见 README 的「权限规则」）对 ACP 同样生效：命中 deny 直接拒绝、不请求；命中 allow 直接放行、不请求。写错的规则会被忽略，`initialize` 时往 stderr 写一行。

超时 60 秒或客户端不支持该方法时，按拒绝处理。

权限模式：

| `TRANSCODE_PERMISSION_MODE` | 行为 |
| --- | --- |
| `ask`（默认） | 变更类工具向客户端请求授权 |
| `readonly` | 只允许读/搜索；写和 bash 直接拒绝 |
| `plan` | 只读；变更被拒并引导 Agent 以实施方案（`PLAN READY`）收尾，不向客户端请求授权 |
| `auto` | 全部自动允许 |

## 模型解析

`session/new` / `session/set_model` / `TRANSCODE_MODEL` 使用同一套解析：

1. 注册表 id：`opus`、`gpt`、`deepseek`、`glm`、`minimax`、`kimi`
2. `provider:model`：`openai:gpt-4o`、`anthropic:claude-sonnet-4-20250514`、`deepseek:deepseek-chat`、`kimi:moonshot-v1-128k` 等
3. 裸模型名：按名字推断 provider（`claude*` / `deepseek*` / `glm*` / `kimi*` / `minimax*`），否则走 `TRANSCODE_DEFAULT_PROVIDER`（默认 `openai`）
4. 空值：`TRANSCODE_MODEL` → `ANTHROPIC_DEFAULT_FABLE_MODEL_NAME` / `ANTHROPIC_DEFAULT_FABLE_MODEL` / `ANTHROPIC_MODEL`（当配置了 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_BASE_URL`）→ `opus`

Anthropic 适配器会：

- 用 `ANTHROPIC_BASE_URL` 作为 `anthropicApiUrl`
- 在 `ANTHROPIC_API_KEY` 缺失时用 `ANTHROPIC_AUTH_TOKEN` 作为 key 和 bearer token
- 去掉 LangChain 默认的 `top_k = -1` / `top_p = -1`，否则部分兼容网关会直接返回 400

OpenAI 兼容网关可以用 `OPENAI_BASE_URL` 覆盖 base URL；`TRANSCODE_BASE_URL` 覆盖所有 provider。API Key 优先取 provider 对应变量，其次 `TRANSCODE_API_KEY`。

## 与 multica 的兼容点

- multica 的 `hermes` 协议家族会用 `<command> acp` 启动本地 runtime，因此 transcode 提供 `acp` 子命令。
- multica 通过 `initialize` → `session/new` → `session/prompt` 驱动一个 turn。
- 任务 brief 通常出现在 prompt 文本和/或 workspace 的 `AGENTS.md` 中；transcode 两者都会读取。
- multica 对 `session/request_permission` 会自动选择 `allow_once`。
- transcode 不广告 `loadSession`，因此每个任务默认新 session；如果同一进程内复用 session，会保留内存中的对话历史。
- 不使用 MCP 时 multica 传来的 `mcpServers` 为空；有值会被忽略。

## 调试

```bash
# 协议 smoke test（不需要 API Key）
bun run test:acp

# 手动观察协议帧
TRANSCODE_MOCK=1 bun bin/transcode.ts acp
```

手工发送一帧：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"manual","version":"0"},"clientCapabilities":{}}}' \
  | TRANSCODE_MOCK=1 bun bin/transcode.ts acp
```

stderr 上会看到 `[transcode] ACP server ready`、session 创建、权限拒绝等诊断信息；stdout 只应出现 JSON。
