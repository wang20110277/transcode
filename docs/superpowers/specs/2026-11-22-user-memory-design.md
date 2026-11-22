# 用户记忆系统(全局指令 + 自动记忆)— 设计

## 意图

让 transcode 跨会话、跨项目记住用户偏好与纠正。项目级记忆(TRANS.md/AGENTS.md 注入)已有;本设计补齐用户级:全局指令文件、agent 自主写入的自动记忆、REPL 查看入口。对 ACP 定位尤其重要——transonce/multica 反复拉起 transcode,每次会话都能带上积累的偏好,而不是每次白纸。

## 设计(参考 claudecode/docs/context/project-memory.mdx 与 CC auto-memory)

**存储**(根目录默认 `~/.transcode/`,与 sessions 同级;整体可用 `TRANSCODE_USER_DIR` 覆盖——`TRANS.md` 与 `memory/` 一起切到测试根,仿 `sessionsDir()` 的 env 注入,保证测试不碰真实用户数据):

- `~/.transcode/TRANS.md` — 全局指令,用户手写(相当于 `~/.claude/CLAUDE.md`:"我所有项目都用 bun、commit 用中文")
- `~/.transcode/memory/MEMORY.md` — 索引,每条一行:`- [标题](文件.md) — 一句话钩子`
- `~/.transcode/memory/<slug>.md` — 一条事实一个文件:frontmatter(`name` / `description` / `type`)+ 正文。type 取值:`user`(用户是谁、偏好) | `feedback`(对 AI 行为的纠正) | `project`(跨会话项目约束) | `reference`(外部资源指针)。frontmatter 行级解析这三键,不引 yaml 依赖

**注入**(改 `system-prompt.ts`;REPL 与 ACP 两入口自动生效):

- 新增 `loadUserMemory()`:读全局指令 + 索引 + 全部记忆文件,合计预算 **12k 字符**。超预算策略:TRANS.md 超长按现有项目文件方式截断;记忆条目**整条丢弃、不腰斩**(半条指令比省略更危险),按 type 优先级 `user > feedback > project > reference` 先丢最低,注入末尾注明被省略的条目名(记忆本就该小)
- `buildSystemPrompt` 新增 `## User memory` 段,位于 Project instructions 之前:全局指令原文 + 记忆索引 + 各条内容
- "How to work" 增一条:用户纠正行为或表达持久偏好时,用 `memory_save` 记下;引用可能过期的记忆前先验证(文件还在?函数还存在?)

**工具**(注册进 `AGENT_TOOLS`,ACP 与子 agent 同享):

- `memory_save { name, type, content, description? }` — 新建/覆盖一条记忆并同步 MEMORY.md 索引;`description`(frontmatter + 索引钩子)可选,缺省取 content 首行截 60 字符,不为它多打一次模型调用;description 里写明**不该存什么**(代码结构、git 历史、临时任务状态、TRANS.md 已有内容),让模型自筛(CC 同款清单)
- `memory_delete { name }` — 删条目并同步索引
- 均 `isMutating: true`,沿用现有两道门禁:plan 模式(`loop.ts` 的 `planMode` 只读探索)与 `readonly` 权限模式都会拒绝 mutating 工具,无需新增模式

**命令**(REPL 兜底,本地直写、不经模型):

- `/memory` — 列索引 + 存储路径 + 手动编辑提示
- `/remember <text>` — 快速存一条 `type=user` 记忆(name 自动 slug,冲突加序号)
- `/forget <name>` — 删除

**刷新**:无需失效机制——REPL(`REPL.tsx:409`)与 ACP(`acp/session.ts:125`)每次提交都重建 system prompt,记忆变更下一轮即生效。

**测试**:memory 存取纯函数(增删、索引同步、预算截断、坏 frontmatter 容错);两工具 schema/execute;system-prompt 注入格式。新文件:`src/agent/memory.ts` + `src/agent/tools/memory.ts`(工具),命令进 `commands.ts`。

## 非目标

- @import 语法、子目录嵌套 AGENTS.md(方案 C 内容)
- 相关性召回/向量检索(条数少,预算内全量注入;条数膨胀后再上)
- 记忆过期自动清理、跨设备同步

## 备选(已否)

- 只加全局指令文件(方案 A):agent 不会自己积累,每次仍白纸
- 只注入索引 + 按需读取工具:省 token 但多一套召回机制,MVP 不值
- 单一 memory 工具带 action 字段:与仓库粒度工具风格(files/search 等均拆分)不一致
- `/remember` 走完整 agent loop(仿 /init):慢且不确定,本地直写即可
