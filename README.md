# transcode

多模型 AI 编码 Agent CLI。当前 MVP 的目标是：**作为本地 Agent 被 multica 通过 ACP 调用**。

- 终端侧：Ink REPL（保留原有命令：`help` / `models` / `clear` / `exit`）
- Agent 侧：`transcode acp` 启动 ACP v1 stdio 服务，供 multica daemon 等客户端调用
- 模型侧：Anthropic / OpenAI 及任意 OpenAI 兼容网关（DeepSeek、GLM、MiniMax、Kimi、自建网关等）
- 工具侧：`read_file` / `write_file` / `edit_file` / `glob` / `grep` / `bash`

## 环境要求

- Bun >= 1.3
- 至少一个模型提供商的 API Key

```bash
bun install
```

也可以全局安装（需要本机有 Bun，因为入口是 `#!/usr/bin/env bun`）：

```bash
npm i -g @trans-ai/trans-code
# 或在本仓库内
bun link
```

## 配置模型

通过环境变量配置，模型可以是注册表 id，也可以是 `provider:model`：

```bash
# 注册表 id: opus | gpt | deepseek | glm | minimax | kimi
export ANTHROPIC_API_KEY=...
export DEEPSEEK_API_KEY=...
export TRANSCODE_MODEL=deepseek

# 或者显式指定 provider:model
export OPENAI_API_KEY=...
export TRANSCODE_MODEL=openai:gpt-4o
```

### 复用 Claude Code 的 Anthropic 兼容配置

如果你已经有一个 Anthropic 兼容网关（例如 DeepSeek 的 `/anthropic` 端点），可以直接沿用 Claude Code 的环境变量，不需要改 `TRANSCODE_MODEL`：

```bash
export ANTHROPIC_AUTH_TOKEN=sk-...
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_DEFAULT_FABLE_MODEL='deepseek-v4-pro[1M]'
export ANTHROPIC_DEFAULT_FABLE_MODEL_NAME=deepseek-v4-pro

transcode acp
```

transcode 会：

- 优先使用 `ANTHROPIC_DEFAULT_FABLE_MODEL_NAME`（去掉 `[1M]` 这类上下文后缀），其次 `ANTHROPIC_DEFAULT_FABLE_MODEL`，再其次 `ANTHROPIC_MODEL`
- 用 `ANTHROPIC_BASE_URL` 作为 Anthropic base URL
- 用 `ANTHROPIC_AUTH_TOKEN` 作为 bearer token（当 `ANTHROPIC_API_KEY` 未设置时）
- 自动丢弃 `top_k` / `top_p` 默认值，避免严格网关返回 `top_p` 越界错误

验证：

```bash
bun run model:check          # 直接问模型一句话
bun run test:acp:real        # 完整 ACP + 工具调用（会创建临时 workspace）
```

常用变量：

| 变量 | 说明 |
| --- | --- |
| `TRANSCODE_MODEL` | 默认模型。注册表 id、`provider:model`，或裸模型名 |
| `TRANSCODE_DEFAULT_PROVIDER` | 裸模型名走哪个 provider，默认 `openai` |
| `TRANSCODE_PERMISSION_MODE` | `ask`（默认） / `auto` / `readonly` |
| `TRANSCODE_ALLOW_OUTSIDE_CWD` | 设为 `1` 才允许读写工作区之外的路径 |
| `TRANSCODE_BASE_URL` | 覆盖当前模型的 base URL（所有 provider） |
| `TRANSCODE_MAX_TOKENS` | 单次回复的 `max_tokens`，默认 `8192` |
| `TRANSCODE_MOCK` | 设为 `1` 使用本地 mock 模型（仅用于协议测试） |

`provider:model` 支持的前缀：`openai`、`anthropic`、`deepseek`、`glm`、`minimax`、`kimi`、`moonshot`。
裸模型名会使用 `TRANSCODE_DEFAULT_PROVIDER`；`openai` 前缀和裸模型名可以用 `OPENAI_BASE_URL` 指向兼容网关，`TRANSCODE_BASE_URL` 则可以覆盖任意 provider。

## 本地运行

```bash
# ACP 服务（给 multica 用）
bun bin/transcode.ts acp

# 交互式 REPL
bun run start

# 检查
bun run typecheck
bun run test:acp          # ACP 协议 + 工具事件（mock 模型）
bun run test:acp:openai   # 真实 LangChain 流式 + 工具循环（本地假 OpenAI 服务）
bun run test:acp:real     # 真实模型 + 真实工具调用（无 key 时自动跳过）
```

## 接入 multica

multica daemon 支持“自定义 runtime profile”：选择一个已支持的协议家族，但用你自己的可执行文件启动。transcode 实现的是 **ACP** 协议，因此用 `hermes` 家族接入。multica 会用 `<command> acp` 启动它。

### 1. 让 `transcode` 出现在 PATH

二选一：

```bash
# 方式 A：bun link（会把当前包链接到全局 bin）
cd /Users/lindaw/Documents/transcode
bun link

# 方式 B：直接使用绝对路径，后面用 runtime profile set-path 指定
chmod +x bin/transcode.ts
```

确认：

```bash
transcode --version
```

### 2. 创建 runtime profile

```bash
multica runtime profile create \
  --runtime-type hermes \
  --command-name transcode \
  --display-name "Transcode"
```

如果 `transcode` 不在 daemon 的 PATH 上，给它固定一个绝对路径：

```bash
multica runtime profile list
multica runtime profile set-path <profile-id> --path /Users/lindaw/Documents/transcode/bin/transcode.ts
```

### 3. 重启 daemon 并确认注册

```bash
multica daemon restart
multica daemon logs -n 200 | grep -i transcode
```

然后在 multica 里为 Agent 选择 `Transcode` runtime，并开始任务。

### 4. 模型与权限

multica 任务会通过 `session/new` / `session/set_model` 传模型名；环境变量作为默认值：

```bash
export TRANSCODE_MODEL=deepseek
export DEEPSEEK_API_KEY=...
multica daemon restart
```

ACP 默认权限模式是 `ask`：写文件、改文件、执行命令前会向客户端发 `session/request_permission`。multica 会自动选择 `allow_once`。如果你在别的 headless 客户端里使用，可以设 `TRANSCODE_PERMISSION_MODE=auto`；设为 `readonly` 则只允许读/搜索。

## 工具

| 工具 | 说明 | 是否需要授权 |
| --- | --- | --- |
| `read_file` | 读取文本文件，带行号，支持 offset/limit | 否 |
| `glob` | 按 glob 查文件 | 否 |
| `grep` | 正则搜索文件内容 | 否 |
| `write_file` | 创建/覆盖文件 | 是 |
| `edit_file` | 精确字符串替换 | 是 |
| `bash` | 在 workspace 内执行 bash 命令 | 是 |

所有路径默认限制在任务 workspace（`cwd`）内；`..` 越界会被拒绝，除非显式设置 `TRANSCODE_ALLOW_OUTSIDE_CWD=1`。

## 上下文

每次 turn 会加载 workspace 下的 `AGENTS.md`、`CLAUDE.md`、`TRANSCODE.md`、`.transcode/AGENTS.md`（存在时）并注入系统提示，因此 multica 写入的任务说明、仓库约定都能被 Agent 看到。

## ACP 协议

支持的方法、事件格式、权限流程和调试方式见 [docs/ACP.md](docs/ACP.md)。

## MVP 限制

- 不支持 MCP（会忽略 `mcpServers` 并在 stderr 提示）
- 不支持 ACP session 持久化：`loadSession: false`，进程内 session 在进程退出后丢失
- 只处理文本 prompt；图片/音频/嵌入式资源暂不支持
- 没有 Web 搜索、子 Agent、hooks、自动压缩
- 工具输出有长度上限，避免单次上下文爆炸
- `TRANSCODE_MOCK=1` 仅用于协议 smoke test，不会调用真实模型

## 目录

```
src/
  acp/            ACP JSON-RPC 传输、server、session
  agent/          Agent 循环、工具实现、系统提示
  provider/       多模型注册与 LangChain 适配
  screens/        Ink REPL
  commands.ts     REPL 命令
  cli.ts          命令行入口分发
  main.tsx        REPL 入口
bin/transcode.ts  可执行入口
scripts/acp-smoke.ts
docs/ACP.md
```
