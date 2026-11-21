# 会话压缩(恢复时自动 + /compact 主动)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复超过 10 轮的会话时自动把旧轮提炼为「前情提要」并写回;`/compact` 随时主动压缩当前会话;恢复后以对话形式展示提要 + 最近 10 轮。

**Architecture:** 纯逻辑(切轮、提炼编排、窗口渲染)落 `src/sessions/compact.ts` 走 TDD;REPL 三入口(选择器 Enter、带参 resume、/compact)共用 `compressSession`;模型上下文通过「副本注入 + 结果剔除」携带提要,持久化文件不含注入消息。

**Tech Stack:** TypeScript、Ink、LangChain BaseMessage、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-21-resume-compact-design.md`

## Global Constraints

- `KEEP_TURNS = 10`(导出常量);轮 = 一条 HumanMessage 到下一条 HumanMessage 前,开头的 SystemMessage 属 leading 不算轮
- 提炼 prompt 要求 ≤约 500 字,保留:决定与结论、关键事实(文件/代码/命令)、未完成事项
- 失败(模型抛错/空返回)→ 全量恢复原会话 + 提示,不阻塞、不写坏文件
- ≤10 轮零行为变化;旧会话无 `summary` 字段必须照常工作
- 持久化文件不得包含注入的【前情提要】消息;`runAgentLoop` 会原位 unshift,注入必须传副本
- 测试一律 `TRANSCODE_SESSIONS_DIR` 指向 mkdtemp 临时目录

## Review Focus

- ≤10 轮恢复:不触发压缩、全量渲染(不误触发/不渲染空提要块)
- 压缩失败路径:原 record 原样返回、文件未被改写、UI 提示而非静默
- 注入消息泄漏:保存文件与 `messagesRef` 中都不出现【前情提要】SystemMessage(跨多轮也不累积)
- 已压缩会话再次恢复(summary 有值、轮数 ≤10):不重复压缩、提要块照常渲染
- 滚动合并:第二次压缩的 prompt 包含旧摘要文本
- 超大旧会话(旧 200KB 级):transcript 有截断保护,不超模型上下文
- picker Enter 异步压缩期间的键盘:busy 门控,不可再提交

---

### Task 1: 压缩核心(splitTurns / compressSession / renderTranscript)

**Files:**
- Create: `src/sessions/compact.ts`
- Test: `src/sessions/compact.test.ts`

**Interfaces:**
- Consumes: `SessionRecord`、`BaseMessage`(store.js/@langchain/core)
- Produces(Task 3 依赖):
  - `export const KEEP_TURNS = 10`
  - `splitTurns(messages: BaseMessage[]): { leading: BaseMessage[]; turns: BaseMessage[][] }`
  - `compressSession(record, model: { invoke(input: string): Promise<{ content: unknown }> }): Promise<{ compressed: boolean; record: SessionRecord; error?: string }>`
  - `renderTranscript(summary: string | null, messages: BaseMessage[]): string`

- [ ] **Step 1: 写失败测试**

```ts
describe('splitTurns', () => {
  // 构造:[System, Human(a), AI, Tool, AI, Human(b), AI]
  test('leading system messages are not a turn; tool/AI messages attach to their human turn', () => {
    const { leading, turns } = splitTurns(msgs);
    expect(leading.map(m => m.getType())).toEqual(['system']);
    expect(turns.length).toBe(2);
    expect(turns[0]!.map(m => m.getType())).toEqual(['human', 'ai', 'tool', 'ai']);
  });
});

describe('compressSession', () => {
  test('more than KEEP_TURNS: trims to window, sets summary, keeps leading, bumps updatedAt', async () => {
    // 12 轮 + leading System;mock model 返回 '提要内容'
    const { compressed, record } = await compressSession(rec12, mockModel('提要内容'));
    expect(compressed).toBe(true);
    expect(record.summary).toBe('提要内容');
    expect(splitTurns(record.messages).turns.length).toBe(10);
    expect(record.messages[0]!.getType()).toBe('system');
  });
  test('at or below KEEP_TURNS is a no-op returning the original record', async () => {
    const { compressed, record } = await compressSession(rec10, mockModel('x'));
    expect(compressed).toBe(false);
    expect(record).toBe(rec10);
  });
  test('model failure returns original record with error', async () => {
    const { compressed, record, error } = await compressSession(rec12, failingModel);
    expect(compressed).toBe(false); expect(error).toBeDefined(); expect(record).toBe(rec12);
  });
  test('rolling merge: previous summary appears in the prompt', async () => {
    // rec12.summary = '旧提要';捕获 invoke 入参
    expect(capturedPrompt).toContain('旧提要');
  });
  test('huge old transcript is truncated before invoking the model', async () => {
    // 单轮巨文本;断言 invoke 入参长度 < 上限常量
  });
});

describe('renderTranscript', () => {
  test('renders summary block plus human/ai pairs, skipping tool/system', () => {
    const out = renderTranscript('提要', windowMsgs);
    expect(out).toContain('前情提要'); expect(out).toContain('你:'); expect(out).toContain('AI:');
    expect(out).not.toContain('工具');
  });
  test('null summary renders turns only', () => { /* 无提要块 */ });
});
```

- [ ] **Step 2: 跑测试确认失败** — `bun test src/sessions/compact.test.ts` → FAIL(模块不存在)
- [ ] **Step 3: 实现 `src/sessions/compact.ts`**
  - `splitTurns`:首个 HumanMessage 前的都进 leading;此后每个 HumanMessage 开新轮
  - `compressSession`:≤KEEP → `{ compressed: false, record }`;否则渲染旧轮文本(用户:/助手:/工具结果:,单条超长截断),总长超 `TRANSCRIPT_LIMIT = 40_000` 字符时留尾部并前缀「(更早内容已截断)」;prompt = 提炼指令 + (record.summary ? `已有前情提要:\n…\n` : '') + transcript;调 `model.invoke`,返回文本清洗后为空 → error;成功 → 新 record(`summary`=文本,`messages`=[...leading, ...末 10 轮展开],`updatedAt`=Date.now())
  - `renderTranscript`:summary 非空 → `📝 前情提要(旧 N 轮)\n${summary}\n`;窗口内 Human→`你: ${text}`、AI→`AI: ${text}`(各截 120 字/行),Tool/System 跳过
- [ ] **Step 4: 跑测试确认通过** — 同命令 → PASS
- [ ] **Step 5: Commit** — `git add src/sessions/compact.ts src/sessions/compact.test.ts && git commit -m "feat: session compaction core (split turns, distill, transcript render)"`

### Task 2: store 增加 summary 字段

**Files:**
- Modify: `src/sessions/store.ts:14-22`(SessionRecord)、`src/sessions/store.test.ts`
**Interfaces:**
- Produces: `SessionRecord.summary?: string`(Task 3 读写;saveSession 已展开 record,字段自动持久化,读回经 readRecord 展开)

- [ ] **Step 1: 失败测试** — store.test.ts 增:`saveSession({...sample(), summary: '旧提要'})` → `getSession('ses_test1')?.summary === '旧提要'`;不带 summary 的旧记录 → `?.summary` 为 undefined
- [ ] **Step 2: 确认失败** — 类型缺字段导致编译错(FAIL 正当)
- [ ] **Step 3: 实现** — SessionRecord 加 `/** Distilled digest of turns older than the kept window. */ summary?: string;`
- [ ] **Step 4: 确认通过**(跑 store 测试)
- [ ] **Step 5: Commit** — `feat: persist optional session summary field`

### Task 3: REPL 三入口接线 + 上下文注入

**Files:**
- Modify: `src/screens/REPL.tsx`(applyResume 区、handleSubmit turn 调用区 :300、resume 分支、新增 compact 分支)、`src/commands.ts`(/compact 注册)
**Interfaces:**
- Consumes: Task 1 全部导出、`SessionRecord.summary`、`createModel`(provider.js)
- Produces: 无

- [ ] **Step 1: summaryRef 与注入/剔除** — `const summaryRef = useRef<string | null>(null);`;提交 turn 时:若 `summaryRef.current` 非空,构造副本数组,在 leading system 消息后插入 `new SystemMessage('【前情提要】\n' + summary)` 传给 `runAgentLoop` 的 `messages`;`messagesRef.current = result.messages` 改为先剔除(过滤 system 且 content 以「【前情提要】」开头的消息);`applyResume` 同步 `summaryRef.current = record.summary ?? null`;/new 清空
- [ ] **Step 2: 恢复路径压缩** — picker Enter 与带参 resume 共用异步流程:加载 record 后,`splitTurns(record.messages).turns.length > KEEP_TURNS` 时置 busy + 「正在提炼前情…」→ `compressSession(record, createModel(ctx.modelId))`;compressed → `saveSession(新 record)` 再 `applyResume`;error → `applyResume(原 record)` + 追加「压缩失败,已恢复完整对话」;最后 `addHistory(renderTranscript(summaryRef.current, messagesRef.current))` 渲染窗口(≤10 轮也渲染,无提要块)
- [ ] **Step 3: /compact 命令** — commands.ts 注册占位条目(name `compact`,描述「压缩当前会话:旧轮提炼为前情提要,保留最近 10 轮」,注明 Intercepted by the REPL);REPL handleSubmit 内联:无会话 →「当前没有进行中的会话」;≤10 轮 →「无需压缩(当前 N 轮)」;否则同 Step 2 流程,成功后 `messagesRef/summaryRef` 就地更新 + `saveSession` + 渲染提要块
- [ ] **Step 4: 全量验证** — `bun test` 全绿 + `npm run typecheck` 无输出 + `npm run build:repl` 成功
- [ ] **Step 5: Commit** — `feat: auto-compact on resume and /compact command with digest context injection`
