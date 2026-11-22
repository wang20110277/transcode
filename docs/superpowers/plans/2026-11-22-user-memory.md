# 用户记忆系统(User Memory)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** transcode 跨会话/跨项目记住用户偏好:`~/.transcode/TRANS.md` 全局指令 + `memory/` 自动记忆 + `memory_save`/`memory_delete` 工具 + `/memory` `/remember` `/forget` 命令。

**Architecture:** 新增 `src/agent/memory.ts` 存储层(目录文件是事实源,MEMORY.md 是 save/delete 时再生的产物);两个工具经 `dispatchPool` 进 `AGENT_TOOLS`(REPL/ACP/子 agent 同享);`loadProjectContext` 顺带装载用户记忆、`buildSystemPrompt` 渲染 `## User memory` 段——REPL(`src/screens/REPL.tsx:409`)与 ACP(`src/acp/session.ts:125`)每次提交都重建 prompt,记忆变更下一轮自动生效,无需失效机制,两调用点零改动。

**Tech Stack:** TypeScript + Bun test + zod(均已有,不引新依赖)。

**Spec:** `docs/superpowers/specs/2026-11-22-user-memory-design.md`

## Global Constraints

- 不引新依赖:frontmatter 行级解析,只认 `name` / `description` / `type` 三键,不引 yaml
- 文件是事实源:`loadUserMemory` 扫描目录文件;MEMORY.md 只在 save/delete 时从文件状态重新生成,装载时不读它
- 所有写盘原子化:tmp + rename,仿 `src/sessions/store.ts:124`
- 测试隔离:`TRANSCODE_USER_DIR` 指向 `mkdtemp` 根,try/finally 清理(仿 `system-prompt.test.ts` 对 `TRANSCODE_CONFIG_PATH` 的用法)
- 两工具 `isMutating: true`,不新增权限模式(plan 模式与 readonly 沿用 `loop.ts` 现有 isMutating 门禁)
- 预算 `12_000` 字符,条目整条丢弃不腰斩,优先级 `user > feedback > project > reference`
- 每任务收尾:`bun test` 全绿 + `bun run typecheck` 通过

## Review Focus

1. **首跑/目录不存在** → `loadUserMemory` 返回空对象、`saveMemory` 自建目录、`/memory` 显示空态(Task 1、4 测试)
2. **MEMORY.md 缺失或手改过期** → 装载/保存都以目录文件为准,索引可再生日后自动愈合成正确状态(Task 1)
3. **坏 frontmatter**(无 `---`、缺 type、未知 type、空文件)→ 该条跳过,绝不崩(Task 1)
4. **预算边界** → 超预算整条丢最低优先级并在 `omitted` 注名;TRANS.md 单独超长按现有项目文件方式截断加注(Task 1、3)
5. **危险 name**(空、含 `/`、`..`)→ 拒绝并返回可读错误;两工具 `isMutating=true` 被 plan/readonly 门禁拒绝(Task 1、2)

---

### Task 1: 记忆存储层 `src/agent/memory.ts`

**Files:**
- Create: `src/agent/memory.ts`
- Test: `src/agent/memory.test.ts`

**Interfaces:**

```ts
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export interface MemoryEntry { name: string; type: MemoryType; description: string; content: string }
export interface UserMemory { globalInstructions: string | null; entries: MemoryEntry[]; omitted: string[] }
export const USER_MEMORY_BUDGET_CHARS = 12_000;
export function userMemoryRoot(): string;            // process.env.TRANSCODE_USER_DIR ?? ~/.transcode
export function globalInstructionsPath(): string;    // <root>/TRANS.md
export function memoryDir(): string;                 // <root>/memory
export function sanitizeMemoryName(name: string): string | null; // trim 后空/含 / \ .. → null
export function parseMemoryFile(raw: string): MemoryEntry | null; // 坏 frontmatter → null
export function renderMemoryFile(entry: MemoryEntry): string;     // 写盘格式,预算成本即此长度
export function renderMemoryIndex(entries: MemoryEntry[]): string; // MEMORY.md 内容
export function loadUserMemory(): Promise<UserMemory>;
export function saveMemory(input: { name: string; type: MemoryType; content: string; description?: string }): Promise<MemoryEntry>;
export function deleteMemory(name: string): Promise<boolean>;
```

文件格式(写盘与解析共用):

```markdown
---
name: bun-not-node
type: feedback
description: 用户所有项目用 bun 而非 node
---
正文,一条事实。
```

索引行:`- [name](name.md) — description`。

- [ ] **Step 1: 写失败测试**(bun:test + mkdtemp 根 + `TRANSCODE_USER_DIR`,try/finally 清理),覆盖:

```ts
test('save→load 往返:文件 + 索引 + frontmatter 三键')
test('索引是再生产物:手删 MEMORY.md 后 load 仍返回条目,save 后索引重建')
test('预算:大 reference + 小 user 超预算 → user 保留、reference 进 omitted')
test('TRANS.md 超预算 → 截断并附 "... (global instructions truncated)"')
test('坏 frontmatter(空文件/缺 type/未知 type)→ 跳过该条不崩')
test('危险 name(空、a/b、..)→ saveMemory 抛错,deleteMemory 返回 false')
test('description 缺省取 content 首个非空行截 60 字符')
test('deleteMemory:命中删文件并重写索引,未命中返回 false')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/agent/memory.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `src/agent/memory.ts`**

同步 fs(仿 store.ts,该层无流式需求)。预算算法(测试未完全决定的唯一一处):

```
remaining = USER_MEMORY_BUDGET_CHARS
globalInstructions 超过 remaining → clip + "\n... (global instructions truncated)"
entries 显示序 = readdir 字典序;成本 = renderMemoryFile(entry).length
while 总成本 > remaining 且可丢:
  丢 (priority 最低,同优先级取字典序最后) 一条 → omitted.push(name)
priority: user=3, feedback=2, project=1, reference=0
```

`saveMemory`:sanitize(无效抛 `Error('invalid memory name …')`)→ 原子写 `<dir>/<name>.md` → 重扫目录按字典序重写 MEMORY.md → 返回 entry。目录不存在则 `mkdirSync recursive`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/agent/memory.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: 提交**

```bash
git add src/agent/memory.ts src/agent/memory.test.ts
git commit -m "feat: user memory store with atomic writes and budget"
```

---

### Task 2: Agent 工具 `memory_save` / `memory_delete`

**Files:**
- Create: `src/agent/tools/memory.ts`
- Modify: `src/agent/tools/index.ts:15-28`(dispatchPool 数组加入两工具)
- Test: `src/agent/tools/memory.test.ts`

**Interfaces:**
- Consumes: Task 1 全部导出;`AgentTool`(src/agent/tools/types.ts)
- Produces: `memorySaveTool: AgentTool`(name `memory_save`)、`memoryDeleteTool: AgentTool`(name `memory_delete`)——schema 见下,`kind: 'edit'` / `'delete'`,均 `isMutating: true`

`memory_save` schema:`{ name: z.string().min(1), type: z.enum(['user','feedback','project','reference']), content: z.string().min(1), description: z.string().optional() }`。description 写入**不该存清单**:代码结构、git 历史、临时任务状态、TRANS.md 已有内容(CC 同款,让模型自筛)。

- [ ] **Step 1: 写失败测试**,覆盖:

```ts
test('memory_save 经 execute 落盘:文件 + 索引 + 返回含 name/type')
test('memory_delete 经 execute 删条目,未命中返回 "not found" 文案')
test('两工具 isMutating === true(被 plan/readonly 门禁拒绝的根据)')
test('危险 name 经工具返回 Error 文案而非抛异常')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/agent/tools/memory.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `src/agent/tools/memory.ts`(仿 `todo.ts` 的 AgentTool 结构)并在 `index.ts` 的 dispatchPool 末尾加入两工具**

无效 name/删除未命中:execute 返回可读错误字符串(catch `saveMemory` 的抛错),不向上抛。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `bun test src/agent/tools/memory.test.ts && bun test && bun run typecheck`
Expected: PASS 全绿

- [ ] **Step 5: 提交**

```bash
git add src/agent/tools/memory.ts src/agent/tools/memory.test.ts src/agent/tools/index.ts
git commit -m "feat: memory_save and memory_delete agent tools"
```

---

### Task 3: system prompt 注入

**Files:**
- Modify: `src/agent/system-prompt.ts:26-30`(ProjectContext)、`:64-82`(loadProjectContext)、`:85-137`(buildSystemPrompt)
- Test: `src/agent/system-prompt.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `UserMemory` / `loadUserMemory` / `renderMemoryIndex`
- Produces: `ProjectContext.userMemory?: UserMemory`(可选——现有测试传 `{ cwd, projectFiles: [] }` 不受影响,REPL/ACP 调用点零改动)

- [ ] **Step 1: 写失败测试**,覆盖:

```ts
test('userMemory 有内容 → 渲染 ## User memory 段,位于 ## Project instructions 之前')
test('段内含 Global instructions 原文、索引行、各条 #### name 与正文、omitted 注名行')
test('userMemory 为空/缺省 → 不渲染该段;How to work 始终含 memory_save 引导行(纠正即记、引用前先验证)')
test('loadProjectContext 集成:TRANSCODE_USER_DIR 根下放 TRANS.md + memory 条目 → context.userMemory 装载')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/agent/system-prompt.test.ts`
Expected: FAIL(新段不存在)

- [ ] **Step 3: 实现**

`loadProjectContext` 末尾追加 `userMemory: await loadUserMemory()`;`buildSystemPrompt` 在 Project instructions 之前渲染(仅当 globalInstructions 或 entries 非空):`### Global instructions`(原文)+ `### Memory`(索引行 + 各条 `#### name` + 正文 + `(omitted: a, b)` 注名行);How to work 数组追加一行:'- When the user corrects your behavior or states a lasting preference, save it with memory_save; before relying on a possibly stale memory, verify it still holds.'

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `bun test src/agent/system-prompt.test.ts && bun test && bun run typecheck`
Expected: PASS 全绿

- [ ] **Step 5: 提交**

```bash
git add src/agent/system-prompt.ts src/agent/system-prompt.test.ts
git commit -m "feat: inject user memory into system prompt"
```

---

### Task 4: REPL 命令 + README

**Files:**
- Modify: `src/commands.ts`(commands 数组追加三条)
- Modify: `README.md`(命令列表 + 「用户记忆」小节)
- Test: `src/commands.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `loadUserMemory` / `saveMemory` / `deleteMemory` / `sanitizeMemoryName`(无循环依赖:memory.ts 只依赖 node:fs/path/os)
- Produces: 命令 `/memory`、`/remember <text>`、`/forget <name>`(execute 支持 Promise,签名见 `src/commands.ts:20`)

- [ ] **Step 1: 写失败测试**(tmp 根 + env,ctx 传 stub),覆盖:

```ts
test('/memory:有记忆 → 列索引行 + 根路径 + 提示;空态 → "No memories yet" 引导 /remember')
test('/remember 一段话 → 存为 type=user,content=原文,输出确认与 name;同名冲突加 -2 后缀')
test('/forget 命中 → "Forgot <name>.";未命中 → "No memory named"')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/commands.test.ts`
Expected: FAIL(命令不存在)

- [ ] **Step 3: 实现三条命令 + README**

`/remember` slug 算法(测试未完全决定处):取文本前 4 个词的 ascii 部分小写、非字母数字折叠为 `-`;结果为空(纯中文等)→ 取前 8 个字符;冲突 → `-2`、`-3` 递增。`/memory` 输出:Memory 根路径、TRANS.md 行数、索引行、`/remember`/`/forget` 用法提示。README 命令列表补三条 + 「用户记忆」小节(存储路径、自动记忆行为、命令用法)。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `bun test src/commands.test.ts && bun test && bun run typecheck`
Expected: PASS 全绿

- [ ] **Step 5: 提交**

```bash
git add src/commands.ts src/commands.test.ts README.md
git commit -m "feat: /memory /remember /forget commands with docs"
```
