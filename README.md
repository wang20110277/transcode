# transcode

多模型 AI 编码 Agent CLI。当前 MVP 的目标是：**作为本地 Agent 被 transonce、multica 等客户端通过 ACP 调用**。

- 终端侧：Ink REPL（命令：`help` / `models` / `mode` / `route` / `init` / `memory` / `remember` / `forget` / `search` / `clear` / `exit`）
- Agent 侧：`transcode acp` 启动 ACP v1 stdio 服务，供 transonce、multica 等客户端调用
- 模型侧：档案（Profile）+ 角色（Role）路由——一个模型 ID 对应一个地址，不同任务可派发不同模型（含子 Agent）
- 工具侧：`read_file` / `write_file` / `edit_file` / `glob` / `grep` / `bash` / `todo_write` / `memory_save` / `web_fetch` / `web_search` / `ask_model` / `dispatch_agent`

## 环境要求

- Node.js >= 20（全局安装用户；入口为编译后的 `dist/cli.js`，`#!/usr/bin/env node`）
- Bun >= 1.3（仅本仓库开发/构建需要）
- 至少一个模型提供商的 API Key

**平台**：macOS / Linux 原生支持。Windows 需安装 [Git Bash](https://git-scm.com/)（bash 工具自动探测 `C:\Program Files\Git\bin\bash.exe` 等常见位置；也可用 `TRANSCODE_SHELL` 显式指定），超时终止走 `taskkill /T /F` 杀进程树，路径在 Windows/Git-Bash 两种形态间自动转换。纯 PowerShell 环境（无 Git Bash）暂不支持。

```bash
bun install
```

也可以全局安装（v0.12.1 起无需 Bun，npm 会用 Node 运行编译产物）：

```bash
npm i -g @trans-ai/trans-code
# 或在本仓库内
bun link
```

## 配置模型

三种方式，从简到繁：

**1. 环境变量**（注册表 id 或 `provider:model`）：

```bash
# 注册表 id: opus | gpt | deepseek | glm | glmc | minimax | kimi | custom
export ANTHROPIC_API_KEY=...
export DEEPSEEK_API_KEY=...
export TRANSCODE_MODEL=deepseek

# 或者显式指定 provider:model
export OPENAI_API_KEY=...
export TRANSCODE_MODEL=openai:gpt-4o
```

**2. REPL 交互配置**（`/models`）：三级流程——选厂商 → 选模型 → 输入 key（已存的可回车沿用）。
- 模型列表**从网关实时拉取**（`GET /v1/models`，标"网关实时列表"），选的就是实际可用的；网关不提供列表时回退内置精选列表 + "自定义模型名…"自由输入
- key 确认后**自动测试连通性**，显示端点**实际调度的模型**（如智谱 Coding 端点会把 `glm-4.6` 映射为套餐当前的 `glm-5.3-flash`，测试会如实亮出）；失败显示 API 原始报错并可重输
- `custom` 支持任意 OpenAI 兼容网关：base URL → key → **从网关实时模型列表中选**（OneAPI/NewAPI/自建中转即插即见），无需盲填模型名

**3. 档案 + 角色路由**（`~/.transcode.json`，任务级模型分派）：

```jsonc
{
  "apiKeys": { "glm": "…", "deepseek": "…" },
  "profiles": {
    "glm-coding": { "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4", "model": "glm-4.6", "keyId": "glm" },
    "glm-vision": { "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-4.6v", "keyId": "glm" }
  },
  "routing": { "default": "glm-coding", "analysis": "glm-coding", "vision": "glm-vision" }
}
```

- **Profile**：命名档案 = 地址 + 模型名 + keyId（智谱普通端点 / CodePlan 端点各一个档案，共用一把 key；同名覆盖内置注册表）
- **Role**：任意命名的角色 → 档案，`/route analysis glmc` 设置、`/route` 查看、`/route design -` 删除
- ACP `session/set_model` 直接收档案名，宿主可按任务指派不同模型

> **GLM Coding Plan 用户**：套餐只在 Coding 专用端点生效，请用 `glmc` 档案（`https://open.bigmodel.cn/api/coding/paas/v4`）；普通 `glm` 端点会报"429 余额不足"。

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
| `TRANSCODE_MODEL` | 默认模型。注册表 id、档案名、`provider:model`，或裸模型名 |
| `TRANSCODE_DEFAULT_PROVIDER` | 裸模型名走哪个 provider，默认 `openai` |
| `TRANSCODE_PERMISSION_MODE` | `ask`（默认） / `auto` / `readonly`；REPL 里可用 `/mode` 运行时切换 |
| `TRANSCODE_ALLOW_OUTSIDE_CWD` | 设为 `1` 才允许读写工作区之外的路径 |
| `TRANSCODE_BASE_URL` | 覆盖当前模型的 base URL（所有 provider） |
| `TRANSCODE_MAX_TOKENS` | 单次回复的 `max_tokens`，默认 `8192` |
| `TRANSCODE_MAX_TURNS` | Agent 工具回合上限，默认 `200`；触顶会明确提示并写入对话 |
| `TRANSCODE_SUBAGENT_MAX_TURNS` | 子 Agent 回合上限，默认 `25` |
| `TRANSCODE_SKIP_MODEL_CHECK` | 设为 `1` 跳过 /models 的连通性测试 |
| `TRANSCODE_MOCK` | 设为 `1` 使用本地 mock 模型（仅用于协议测试） |

`provider:model` 支持的前缀：`openai`、`anthropic`、`deepseek`、`glm`、`glmc`、`minimax`、`kimi`、`moonshot`。
裸模型名会使用 `TRANSCODE_DEFAULT_PROVIDER`；`openai` 前缀和裸模型名可以用 `OPENAI_BASE_URL` 指向兼容网关，`TRANSCODE_BASE_URL` 则可以覆盖任意 provider。

## 本地运行

```bash
# ACP 服务（给 transonce / multica 等 ACP 客户端用）
bun bin/transcode.ts acp

# 交互式 REPL
bun run start

# 检查
bun run typecheck
bun run test:acp          # ACP 协议 + 工具事件（mock 模型）
bun run test:acp:openai   # 真实 LangChain 流式 + 工具循环（本地假 OpenAI 服务）
bun run test:acp:real     # 真实模型 + 真实工具调用（无 key 时自动跳过）
```

npm 全局安装的用户可以自升级：

```bash
transcode upgrade         # 检查 registry 最新版并升级（开发安装会给出指引）
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
| `read_file` | 文本文件（带行号、offset/limit、超长行截断）；PNG/JPG/GIF/WebP 以多模态图片返回 | 否 |
| `write_file` | 创建/覆盖文件（已存在的文件需先 read 过；返回新文件/变更 diff） | 是 |
| `edit_file` | 精确替换，支持单次多处编辑（`edits[]` 原子应用）；弯/直引号自动归一化 | 是 |
| `glob` | 按 glob 查文件（git 仓库内遵循 `.gitignore`） | 否 |
| `grep` | 正则搜索：上下文行（`context`）、跨行匹配（`multiline`）、`.gitignore` 感知 | 否 |
| `bash` | 用户 shell 执行；**cd 跨调用持久**、登录环境快照、进程组 kill、头尾截断；`run_in_background` 后台运行 | 是（只读命令免确认） |
| `bash_output` | 读取后台任务输出（`task_id` 可选，`wait: true` 等待最多 5s；无 id 时列出全部任务） | 否 |
| `todo_write` | 任务清单（`[x]/[~]/[ ]`），多步任务防漂移 | 否 |
| `ask_model` | 单次问答式分派：把子问题发给某角色的模型，答案回入对话 | 否 |
| `dispatch_agent` | 派发子 Agent：独立模型 + 工具白名单 + 自己的回合循环，只回传最终报告 | 是 |

**bash 免确认规则**：`ls`/`cat`/`grep`/`git status` 等只读命令（含管道、`2>/dev/null` 等无害重定向）自动放行并在结果行标注 `(read-only)`；写入重定向、命令替换、危险参数（`find -delete`、`sed -i`…）照常逐次确认。连续重复调用（含 A-B-A-B 振荡）会被熔断并引导换路子。

所有路径默认限制在任务 workspace（`cwd`）内；`..` 越界会被拒绝，除非显式设置 `TRANSCODE_ALLOW_OUTSIDE_CWD=1`。

## 子任务分派

主 Agent 可以把工作派给不同角色的模型（角色经 `/route` 配置，见上文档案与路由）：

- **`ask_model`**：单次专家问答（分析、设计取舍、审查、看图），无工具、一次调用
- **`dispatch_agent`**：多步研究型子任务 —— 子 Agent 用角色档案的模型 + 工具白名单（默认只读三件套）跑自己的循环。上下文契约是**任务进、报告出**：子 Agent 看不到主对话，任务描述必须自包含；只有最终报告回入主对话。派发本身需用户 y/n 授权，子 Agent 禁止递归派发，回合上限 25
- **图片自动代理**：配置了 `routing.vision` 时，工具产生的图片自动经视觉模型转文字描述，主模型无需多模态能力

主对话有防护栏：探索停滞（30 次零写入）自动催促、无视则强制终止（`stalled`）；交付后长尾钻探会被收尾提醒；上下文接近预算自动摘要压缩（预算按 token,CJK 校准估算）。

**上下文预算**（1M 窗口模型如 GLM-5.3、DeepSeek V4 Pro 建议显式设置）：

- `/models` 流程在连通测试后选档：默认(100k)/128k/256k/512k/1M/自定义——按所选模型写入 `autoCompact.byModel`
- `/compact` 无参查看当前生效配置（模型、token 预算、来源层、keepTurns）；`/compact <N>` 仍为手动压缩
- 手改 `~/.transcode.json`：`autoCompact: { contextTokens, byModel: { "glmc:glm-5.3": 1000000 } }`;优先级 byModel > 环境变量（`TRANSCODE_COMPACT_TOKENS`，旧 `TRANSCODE_COMPACT_CHARS` 自动 /4 折算）> 全局 > 默认 100k;`enabled: false` 一键关闭全部自动压缩,值 0 为按层暗门

## 方案先行

`/plan <任务描述>` 进入只读探索模式：变更类工具全部被拒并引导模型产出**编号实施方案**（以 `PLAN READY` 结束），你确认方案后再让它执行 —— 探索和动手分离，防止一上来就改错。

## 上下文

每次 turn 按优先级加载 workspace 下的 `TRANS.md`、`AGENTS.md`、`CLAUDE.md`、`TRANSCODE.md`、`.transcode/AGENTS.md`（存在时）注入系统提示。REPL 里 `/init` 可让 Agent 自行探索仓库并生成 `TRANS.md`（项目背景 / 命令 / 架构 / 约定）。

## 用户记忆

跨会话、跨项目记住你的偏好与对 Agent 的纠正，存放在 `~/.transcode/`：

- **全局指令** `~/.transcode/TRANS.md`——手写一次、所有项目生效（"所有项目用 bun"、"commit 用中文"）
- **自动记忆** `~/.transcode/memory/`——一条事实一个文件，`MEMORY.md` 是索引。Agent 有 `memory_save` / `memory_delete` 工具：你纠正它的行为或表达持久偏好时，它会自己记下来；也可以直接 `/remember <text>` 手动存、`/forget <name>` 删、`/memory` 查看

注入预算 12k 字符，超预算整条省略最低优先级（user > feedback > project > reference）并在提示中注明。记忆目录文件是事实源，`MEMORY.md` 删除后会自动重建。测试与隔离用环境变量 `TRANSCODE_USER_DIR` 覆盖根目录。

## 渲染与交互

- **静态历史架构**：历史每条只打印一次（Ink `<Static>`），流式输出与输入在底部活动区小面积重绘——打字、生成、长会话都不闪烁；回合进行中活动区只显示流式输出的**尾部窗口**（超出部分顶部注明 `… +N lines`），回合结束完整内容落入历史
- **`ctrl+o` 展开明细**：多工具回合折叠为一行摘要（`… +N lines (ctrl+o 展开明细)`），按 ctrl+o 将最近一个折叠回合的工具明细展开打印；连按依次展开更早的回合
- **`/clear` 语义**：已打印的历史无法"收回"——/clear 在下方开始新对话，旧内容保留在终端滚动缓冲中（可自行清屏）

## 联网工具

- **`web_fetch`**：零配置开箱即用。抓 URL 返回可读文本（HTML 剥离为文本 + 标题，text/json 原样，二进制给类型/大小提示）；支持 gbk/gb2312 页面解码，512KB / 20k 字符上限，15s 超时
- **`web_search`**：搜索商由你配置，transcode 只提供实现（厂商无关，GLM/DeepSeek 路由下同样可用）。支持 Tavily 与 Brave，配置两条路：
  - **`/search` 交互**：选搜索商 → 输 key → 发真实测试查询验证 → 自动写入配置
  - **手改 JSON**：`~/.transcode.json` 的 `webSearch: { provider: "tavily" | "brave", apiKey: "…" }`，改完下一轮生效

未配置时 `web_search` 对模型不可见（不浪费轮次）；配置存在但无效会在启动时提示一行。请求使用诚实 UA（`Mozilla/5.0 (compatible; transcode/<version>)`），部分强防护站点可能 403。全局安装（bun 运行时）的联网请求自动识别 `HTTP(S)_PROXY`；自建 Node dist 路径暂不支持代理。

## ACP 协议

支持的方法、事件格式、权限流程和调试方式见 [docs/ACP.md](docs/ACP.md)。

## MVP 限制

- 不支持 MCP（会忽略 `mcpServers` 并在 stderr 提示）
- 不支持 ACP session 持久化：`loadSession: false`，进程内 session 在进程退出后丢失
- prompt 仍以文本为主；图片只支持 `read_file` 读取（≤3MB，多模态模型直读，其余经 vision 角色转述）
- 没有 Web 搜索、hooks、自动压缩；子 Agent 为隔离式（fork 继承上下文模式规划中）
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
