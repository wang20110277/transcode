# ACP 会话持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ACP 会话落盘并支持跨进程恢复——`loadSession: true`,`session/load`/`resume` 走磁盘,新增 `session/list` 与 `session/close`。

**Architecture:** `AcpSession` 自带落盘(每轮 `finally` 里 `saveSession`,标题首轮生成);`AcpServer` 在内存 Map 未命中时经 `sessions/store.ts` 的 `getSession` 拉盘重建会话。REPL 侧零改动。

**Tech Stack:** TypeScript(ESM)、bun:test、`JsonRpcTransport` 内存流(PassThrough)驱动 RPC。

**Spec:** `docs/superpowers/specs/2026-11-28-acp-session-persistence-design.md`

## Global Constraints

- 测试隔离:`process.env.TRANSCODE_SESSIONS_DIR` 指向 tmpdir(与 `TRANSCODE_CONFIG_PATH` 同惯例);`TRANSCODE_MOCK=1` 免模型。
- 会话 id 沿用 `ses_${randomUUID()}` 作记录 id 与文件名;记录 `summary` 字段不写(ACP 无 compaction 产物)。
- 不新增依赖;测试名中文;`bun test`;TDD。
- `session/load` 按 id 全局查(`getSession` 扫全部项目目录),不限定调用方 cwd;找不到统一 `-32002`(RPC_ERRORS.sessionNotFound)。
- 落盘节奏与 REPL 一致:首轮 prompt 完成时生成标题并保存;cancel/error 轮也保存。

## Review Focus

1. 恢复后的续问能接上历史,含 tool_calls 消息链往返(序列化→反序列化不丢 tool_call_id/args)— Task 1/2 测。
2. 未知 id、以及磁盘 JSON 损坏的 id → `-32002`,不崩 — Task 2 测(readRecord 对坏文件返回 null)。
3. mock 模式无模型 → 标题走截断回退,不抛错 — Task 1 测。
4. `session/close` 后 prompt 报 `-32002`,但 load 仍可拉起(磁盘保留)— Task 3 测。
5. `session/list` 只出本项目、新→旧 — Task 3 测(`listProjectSessions` 已排序,测试钉住契约)。

---

### Task 1: AcpSession 落盘(标题 + 每轮保存)

**Files:**
- Modify: `src/acp/session.ts`
- Test: `src/acp/session.test.ts`(新建)
- Docs: spec 与本计划随本任务首次提交

**Interfaces:**
- Produces:
  - `AcpSession` 新增 `readonly createdAt: number`、`private title: string`(初值 `'新对话'`),`persist(): void`(组装 `buildSessionRecord` + `saveSession`,`summary` 不传)。
  - `static AcpSession.fromRecord(host: AcpSessionHost, record: SessionRecord): AcpSession`(messages 用 `record.messages`、`cwd=record.cwd`、`modelSpec=record.model`、title/createdAt 恢复;Task 2 消费)。

- [ ] **Step 1: 写失败测试**

`src/acp/session.test.ts`:fake host(记录 sendUpdate/requestPermission 调用);`TRANSCODE_SESSIONS_DIR=tmpdir`、`TRANSCODE_MOCK=1`;每测 `mkdirSync` 新 tmpdir + 用后清理。用例:

- `一轮 prompt 后落盘,文件含标题与消息`:`session.prompt({prompt:[{type:'text',text:'你好'}]})`(mock 停止即回)→ ` TRANSCODE_SESSIONS_DIR/<projectDir(cwd)>/<session.id>.json` 存在;JSON 的 `title` 为非空回退串(文本截断),`cwd`/`model` 字段正确,`messages` 含 human 文本。
- `tool_calls 消息链往返`:手动 `session.messages.push(new AIMessage({content:'', tool_calls:[{id:'c1',name:'bash',args:{command:'ls'}}]}), new ToolMessage({content:'out', tool_call_id:'c1', name:'bash'}))` 后调 `session.persist()` → 读盘 JSON 含 `tool_calls` 与 `tool_call_id`;再 `AcpSession.fromRecord(host, JSON 反序列化后的 record)` → `messages[1].tool_calls[0].id === 'c1'`、`(messages[2] as ToolMessage).tool_call_id === 'c1'`。
- `第二轮更新同文件`:两轮 prompt → 仍是同一文件名,messages 数增长、`updatedAt` 变大。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/acp/session.test.ts` → FAIL(persist/fromRecord 不存在)

- [ ] **Step 3: 实现**

`prompt()` 的 `finally` 前(成功/取消/错误路径都到)调 `await this.maybeGenerateTitle()` + `this.persist()`;`maybeGenerateTitle`:仅首轮(`messages` 首次出现 assistant 文本后)且有 provider 时 `generateTitle(provider.model, …)`,否则用 `promptText` 截断回退(`generateTitle` 的 fallback 语义,直接内联截断亦可——mock 无 provider 时不能调网络)。实现者按此择一,测试只钉"非空、不抛错"。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交(含 spec+plan 文档)**

```bash
git add src/acp/session.ts src/acp/session.test.ts docs/superpowers/specs/2026-11-28-acp-session-persistence-design.md docs/superpowers/plans/2026-11-28-acp-session-persistence.md
git commit -m "feat: ACP sessions persist to disk each round"
```

### Task 2: load/resume 走磁盘 + 能力声明

**Files:**
- Modify: `src/acp/server.ts`(initialize 与 session/load|resume 分支)
- Test: `src/acp/server.test.ts`(新建)

**Interfaces:**
- Consumes: Task 1 的 `AcpSession.fromRecord`。
- Produces: `initialize` 返回 `loadSession: true`;`session/load`/`session/resume` 语义=内存未命中→盘。

- [ ] **Step 1: 写失败测试**

`src/acp/server.test.ts`:helper 用 `new JsonRpcTransport(new PassThrough(), new PassThrough())` 挂 `AcpServer`,向 input 写 JSON-RPC 行、从 output 收响应(逐行解析,按 id 配对;`request_permission` 主动请求不会被触发——mock 模式无工具)。用例:

- `initialize 声明 loadSession: true`。
- `跨"进程"恢复`:server A 上 `session/new`(cwd=tmp1)→ 一轮 prompt → 丢弃 server A(模拟进程退出)→ server B(新 transport、同一 `TRANSCODE_SESSIONS_DIR`)`session/load` 同 id → 返回同 sessionId;再对该 id 发一轮 prompt 成功(stopReason 正常)。
- `未知 id → -32002`。
- `磁盘损坏 → -32002 不崩`:手工在该会话文件写坏 JSON → load 该 id 报 `-32002`。

- [ ] **Step 2: 跑测试确认失败** → FAIL(load 当前只查内存)

- [ ] **Step 3: 实现**

`session/load|resume` 分支:`this.sessions.get(id)` 命中即返回;否则 `getSession(id)` → `AcpSession.fromRecord(this, record)` 入 Map → `sessionNewResult`;`undefined` → `RpcError(RPC_ERRORS.sessionNotFound, …)`。initialize 的 `loadSession: false` → `true`。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `feat: session/load resumes ACP sessions from disk`

### Task 3: session/list 与 session/close

**Files:**
- Modify: `src/acp/server.ts`
- Test: `src/acp/server.test.ts`(追加)

**Interfaces:**
- Consumes: `listProjectSessions(cwd)`(`src/sessions/resume.ts:4`,返回该项目 `SessionRecord[]`,新→旧)。
- Produces: `session/list` → `{ sessions: Array<{ sessionId: string; title: string; updatedAt: number }> }`;`session/close` → `null`(cancel + Map 删除,磁盘保留)。

- [ ] **Step 1: 写失败测试**

- `session/list 只出本项目且新→旧`:tmp1 建两个会话(各一轮,间隔 `updatedAt`),tmp2 建一个 → `session/list {cwd: tmp1}` 返回 2 条、首条是较新的;id/title 齐全。
- `close 后 prompt 报 -32002,load 可再拉起`:close → prompt 该 id 报 `-32002`;`session/load` 同 id 成功。

- [ ] **Step 2: 跑测试确认失败** → FAIL(method not found)

- [ ] **Step 3: 实现**

`session/list`:`sessionCwd(params.cwd)` 定目录;`session/close`:`getSession(sessionId)` 命中则 `cancel()`+`delete`,未命中直接返回 null(幂等)。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `feat: ACP session/list and session/close over the disk store`

### Task 4: 端到端冒烟 + 文档收尾

**Files:**
- Modify: `scripts/acp-smoke.ts`(加"重启恢复"段)、`docs/ACP.md`、`docs/roadmap.md`

- [ ] **Step 1: 扩冒烟**:acp-smoke.ts 现有流程后:kill 子进程 → 重新 spawn → `session/load` 原 id → 再一轮 prompt → 断言 stopReason 正常。跑 `bun scripts/acp-smoke.ts`(TRANSCODE_MOCK 已置)→ 通过。
- [ ] **Step 2: 全量** `bun test` → 0 fail;`bun run typecheck` → 干净。
- [ ] **Step 3: 文档**:ACP.md 的 load/resume 行改为"内存未命中走 `~/.transcode/sessions` 磁盘恢复",补 `session/list`、`session/close` 两行;roadmap #2 标"状态:已实现"。提交 `docs: mark roadmap item 2 (ACP session persistence) done`。
