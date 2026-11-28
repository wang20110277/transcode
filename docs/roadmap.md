# transcode 迭代路线

日期：2026-11-25 · 状态：计划，尚未立项 · 基线：transcode 0.12.9

## 现状与排序原则

transcode 已经有可用的编码 Agent 内核：多模型与自定义网关、角色路由、权限模式、上下文压缩、会话保存与恢复、用户记忆、联网工具、ACP 服务。接下来要补的是三类缺口：

1. **权限**：只有一次性的 y / n，没有规则，也不能“不再询问”。
2. **扩展点**：MCP、skills、自定义命令与子 agent、hooks 都还没有。
3. **运行时**：工具串行执行，没有用量显示，没有回滚。

排序围绕 transcode 的定位：被 multica、transonce 等客户端通过 ACP 调用，运行在内网的多网关环境。后面的项目会用到前面的成果，所以按阶段推进；阶段三各项彼此独立，可以按需要挑着做。

| 阶段 | 项目 | 目标 |
| --- | --- | --- |
| 一、地基 | 权限规则、ACP 会话持久化、上下文文件层级 | 日常使用和 ACP 接入不再卡在基础能力上 |
| 二、生态 | Skills、自定义命令与子 agent、MCP | 能复用现成的扩展，能接内部工具 |
| 三、运行时质量 | 并行、用量、压缩、撤销、无交互运行、hooks、Windows | 更快、更透明、出错能回退 |

规模是相对 transcode 现有代码量（`src/` 约九千行）的粗估，分小、中、大三档。

## 阶段一：地基

### 1. 权限规则 + “总是允许”（中）

状态：已实现。

- **现状**：四种权限模式（ask / readonly / plan / auto）。ask 模式下每次调用变更类工具都要 y / n 确认，且只管一次；ACP 只向宿主提供“允许一次 / 拒绝”两个选项；唯一的免确认机制是 bash 的只读命令识别。
- **目标**：
  - `~/.transcode.json` 增加 `allow` / `ask` / `deny` 三组规则，支持通配符。规则按工具区分对象：bash 按命令，读写按路径，联网按域名。
  - 授权提示增加“本会话不再问”。
  - ACP 支持并响应 `allow_always`。
  - 优先级是 deny > ask > allow，没命中规则时按当前模式处理。
- **做法**：规则的写法在设计阶段确定，倾向字符串形式，示意：`"allow": ["bash(npm test*)"]`、`"deny": ["read_file(.env*)"]`。这套规则之后同时约束 MCP 工具和 skills。

### 2. ACP 会话持久化（中）

- **现状**：ACP 会话完全不落盘，`loadSession: false`；`session/load` 和 `session/resume` 只能找回同一进程里的会话，进程退出即丢。
- **目标**：声明 `loadSession: true`，`session/load`、`session/list`、`session/resume`、`session/close` 都走磁盘。
- **做法**：复用 REPL 已在用的会话存储（`src/sessions/store.ts`）。分叉放到有了文件快照之后（见阶段三）。

### 3. 上下文文件层级（小）

状态：已实现。

- **现状**：只读工作区根目录的 `TRANS.md`、`AGENTS.md`、`CLAUDE.md`、`TRANSCODE.md`、`.transcode/AGENTS.md`。
- **目标**：
  - 从当前目录向上逐级查找，越近的优先级越高。
  - 支持 `@路径` 导入，设深度和大小上限。
  - Agent 读到某个子目录下的文件时，再加载那个目录的说明文件。
- **做法**：沿用现有的文件名优先级，每一级只取一个。

## 阶段二：生态

### 4. Skills（中）

- **现状**：没有。
- **目标**：
  - 读取 `SKILL.md` 格式的 skills。只把 `name` 和 `description` 放进系统提示，Agent 判断用得上时再加载正文。
  - 用户可以用 `/名称` 直接调用。
  - 目录：用户级 `~/.transcode/skills`，项目级 `.transcode/skills`；同时兼容读取现成的 `.claude/skills`、`.agents/skills`。
- **做法**：frontmatter 先支持 `name` 和 `description`，其余字段以后按需加。

### 5. 自定义命令与子 agent（中）

- **现状**：没有。子 agent 只有 `dispatch_agent`，角色靠 `/route` 配置。
- **目标**：
  - 命令：`.transcode/commands/*.md`（用户级 `~/.transcode/commands/`），是一段可带参数的提示。frontmatter 支持 `description`、`argument-hint`，正文支持 `$ARGUMENTS`、`$1`…`$N`。
  - 子 agent：`.transcode/agents/*.md`（用户级 `~/.transcode/agents/`），是一段系统提示加模型和工具白名单。frontmatter 支持 `name`、`description`、`model`、`tools`。
- **做法**：子 agent 文件直接注册成 `dispatch_agent` 的角色，名称取 `name`，模型和工具白名单取自 frontmatter，与 `/route` 配置的角色并存，不另起一套机制。

### 6. MCP 客户端（大）

- **现状**：没有。ACP 宿主在 `session/new` 里传的 `mcpServers` 被直接忽略，只在 stderr 提示。
- **目标**：
  - 先支持 stdio 和 streamable HTTP 两种传输。
  - 工具以 `mcp__<server>__<tool>` 的名字暴露给模型，受权限规则约束。
  - 配置来源有三处：`~/.transcode.json`、项目里的 `.transcode/mcp.json`、ACP 传入的 `mcpServers`。
- **做法**：工具输出沿用现有的大小上限。OAuth 和“工具很多时的延迟加载”放到后面，等实际需要再做。

## 阶段三：运行时质量

各项从小到中。

- **只读工具并行执行**。现在一轮里的工具调用是逐个执行的；改成同一轮里互不依赖的只读工具并行，并设并发上限。
- **用量显示**。每轮显示 token 用量，输入框下方显示上下文余量；现在只显示工具调用次数。自定义网关拿不到单价，所以先显示 token，费用做成可选。
- **压缩后回注**。压缩后把最近改过的文件重新放回上下文，避免模型重读。
- **文件快照与撤销**。每轮开始前记下被改文件的状态，`/undo` 恢复上一轮的文件改动。快照存在用户目录下的独立存储里，不动用户仓库的提交历史。有了它之后再做对话回退和会话分叉。
- **无交互运行**。`transcode run "提示词" --format json`，给脚本和 Windows 计划任务用。
- **hooks 最小集**。工具调用前后、回合结束、提交提示词这几个事件，先只支持执行 shell 命令。
- **Windows 加固**。在真实终端里跑测试，并加上 Windows 的 CI。0.12.9 修的两个 Windows 问题（banner 右边框错位、会话目录名带盘符冒号）都是手测才发现的。

## 暂不做

- 插件与插件市场、完整的事件 hooks、输出风格、状态栏自定义命令、vim 模式。
- OS 级沙箱。现在只有“路径限制在工作区内”这一层。
- 语音、远程控制、常驻进程、HTTP API 与 SDK、桌面与 Web 界面、worktree 隔离、多 agent 协作。
- LSP 集成、遥测。

这些要么服务于云端产品，要么解决“工具太多”的问题，与 transcode 小、多网关、内网的定位关系不大。
