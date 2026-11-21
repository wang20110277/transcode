# 自动压缩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每轮提交前估算上下文,超阈值自动压缩(与 /compact、resume 同一 `runCompaction`),带配置与连败熔断。

**Architecture:** 纯逻辑(估算 + 配置归一)落 compact.ts/config.ts 走 TDD;REPL 在 handleSubmit 进入 agent loop 前接检查点,复用宿主条目流式显示;基于已审查的 `feat/compact-speed` 分支续作。

**Tech Stack:** TypeScript、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-21-auto-compact-design.md`

## Global Constraints

- 阈值默认 `thresholdChars = 200_000`,估算 `estimateTokens = Σ contentText(chars)/4`
- 配置 `autoCompact?: { enabled?: boolean; thresholdChars?: number }`,默认 **enabled = true**;坏类型/空值全量回落默认(仿 normalizeAutoCompact 与 normalizeAutoUpdate 同风格)
- 熔断:连续失败 **3** 次停止自动压缩,成功复位;失败提示仅每会话首次显示
- 压缩参数 keepTurns = `DEFAULT_KEEP_TURNS`;三入口共用 `runCompaction`
- 跳过:无进行中会话、`TRANSCODE_MOCK=1`、busy

## Review Focus

- 首轮(无 conversationRef)与未达阈值不触发(接线)
- 恰好等于阈值触发(估算 `>=` 边界,Task 1 测试)
- 连败 3 次停、成功复位(接线,ref 语义)
- 坏配置(字符串 thresholdChars、null、数组)回落默认不崩(Task 1 测试)
- 压缩后本轮 loop 使用已压缩 messagesRef 且提要注入生效(复用现有注入点,接线核对)
- autoCompact 与用户提问回显的条目顺序不串(接线)

---

### Task 1: 估算 + 配置归一(纯逻辑)

**Files:**
- Modify: `src/sessions/compact.ts`、`src/sessions/compact.test.ts`、`src/config.ts`、`src/config.test.ts`

**Interfaces:**
- Produces:
  - `estimateTokens(messages: BaseMessage[]): number`(compact.ts;contentText 求和 / 4,向下取整)
  - config.ts:`interface AutoCompactConfig { enabled?: boolean; thresholdChars?: number }`、`interface NormalizedAutoCompact { enabled: boolean; thresholdChars: number }`、`normalizeAutoCompact(raw: unknown): NormalizedAutoCompact`、`TranscodeConfig.autoCompact?: boolean | AutoCompactConfig`(boolean 直通,与 autoUpdate 同款 raw 形状)

- [ ] **Step 1: 失败测试**

```ts
// compact.test.ts
describe('estimateTokens', () => {
  test('sums content chars / 4, floors; non-string content via JSON; empty → 0', () => {
    expect(estimateTokens([])).toBe(0);
    expect(estimateTokens([new HumanMessage('a'.repeat(40))])).toBe(10);
    expect(estimateTokens([new HumanMessage('x'.repeat(10)), new AIMessage('y'.repeat(30))])).toBe(10);
  });
});
// config.test.ts
describe('normalizeAutoCompact', () => {
  test('undefined → enabled default 200_000; false → disabled; valid override kept', () => {
    expect(normalizeAutoCompact(undefined)).toEqual({ enabled: true, thresholdChars: 200_000 });
    expect(normalizeAutoCompact(false)).toEqual({ enabled: false, thresholdChars: 200_000 });
    expect(normalizeAutoCompact({ thresholdChars: 50_000 })).toEqual({ enabled: true, thresholdChars: 50_000 });
  });
  test('garbage (string/null/array/negative) falls back to defaults', () => {
    expect(normalizeAutoCompact('yes')).toEqual({ enabled: true, thresholdChars: 200_000 });
    expect(normalizeAutoCompact([1])).toEqual({ enabled: true, thresholdChars: 200_000 });
    expect(normalizeAutoCompact({ thresholdChars: -5 })).toEqual({ enabled: true, thresholdChars: 200_000 });
  });
});
```

- [ ] **Step 2: 确认失败**(导出不存在)
- [ ] **Step 3: 实现** — `estimateTokens` 用已有 `contentText`;`normalizeAutoCompact` 仿 `normalizeAutoUpdate` 分支
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: Commit** — `feat: token estimation and autoCompact config normalization`

### Task 2: REPL 检查点接线

**Files:**
- Modify: `src/screens/REPL.tsx`(handleSubmit 进入 agent loop 前;import estimateTokens/normalizeAutoCompact/loadConfig 已有)

**Interfaces:**
- Consumes: Task 1 全部;`runCompaction`、`buildSessionRecord`、`transcriptEntries`、`DEFAULT_KEEP_TURNS`、`saveSession`

- [ ] **Step 1: 状态** — `const autoCompactFailuresRef = useRef(0);`、`const autoCompactWarnedRef = useRef(false);`
- [ ] **Step 2: 检查点**(handleSubmit 内、构建 provider/进入 try 之前):条件 `normalizeAutoCompact(loadConfig().autoCompact).enabled && conversationRef.current && process.env.TRANSCODE_MOCK !== '1' && autoCompactFailuresRef.current < 3 && estimateTokens(messagesRef.current) >= cfg.thresholdChars` 满足时:`setBusyBoth(true)` → 空宿主条目 → `runCompaction(buildSessionRecord({...}), DEFAULT_KEEP_TURNS)`;成功 → 回写 refs + `saveSession` + 失败计数清零 + `transcriptEntries` 渲染;失败/异常 → 计数 +1,首次时 `⚠ 自动压缩失败(原因),本轮继续;连续 3 次将暂停自动压缩`,达 3 次时提示「自动压缩已暂停」;finally `setBusyBoth(false)`
- [ ] **Step 3: 全量验证** — `bun test` + `npm run typecheck` + `npm run build:repl`
- [ ] **Step 4: Commit** — `feat: proactive auto-compact with threshold config and failure circuit breaker`
