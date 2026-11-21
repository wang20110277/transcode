# 压缩提速(流式 + compact 路由 + 硬上限)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 压缩调用改为流式并实时显示、可路由快速模型、输出字符硬上限,消除感知与实际慢。

**Architecture:** `CompactModel` 换成 stream 接口,`compressSession` 增 `onDelta` 回调与 `COMPACT_MAX_SUMMARY_CHARS` 截断;REPL 两入口接 `appendChatOutput` 流式显示,模型经 `getRouting()['compact'] ?? ctx.modelId` 选择。

**Tech Stack:** TypeScript、LangChain(`model.stream()`)、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-21-compact-speed-design.md`

## Global Constraints

- `COMPACT_MAX_SUMMARY_CHARS = 1200`,累积超限即停止消费流并 `slice` 到上限
- `CompactModel = { stream(input: string): AsyncIterable<{ content: unknown }> }`;chunk 文本取 `typeof content === 'string' ? content : ''`
- 模型选择:`createModel(getRouting().compact ?? ctx.modelId)`;未配置 routing 行为与现状一致
- 失败回退(流中抛错/空摘要)、滚动合并、≤keepTurns no-op 语义不变;`TRANSCODE_MOCK` 跳过压缩不变

## Review Focus

- 流中第 2 块抛错 → 原会话完整回退、无文件写入(Task 1 测试)
- 显示与保存一致:onDelta 逐块文本拼接 === 最终 summary(Task 1 测试)
- 超限:5000 字符流 → summary ≤ 1200 且提前停止消费(Task 1 测试 + 生成器消费计数)
- 未配 `routing.compact` → 用当前模型(接线:?? 右侧默认)
- 多块 content 非字符串(如数组块)不崩、按空串跳过(Task 1 测试)

---

### Task 1: 流式压缩核心

**Files:**
- Modify: `src/sessions/compact.ts`、`src/sessions/compact.test.ts`

**Interfaces:**
- Produces:
  - `export const COMPACT_MAX_SUMMARY_CHARS = 1200`
  - `export interface CompactModel { stream(input: string): AsyncIterable<{ content: unknown }> }`
  - `compressSession(record, model, keepTurns = DEFAULT_KEEP_TURNS, onDelta?: (delta: string) => void)`(返回形不变)

- [ ] **Step 1: 失败测试** — mock 改 async generator(`streamModel(chunks: string[], opts?: {throwAt?: number; trackPulled?: number[]}): CompactModel & { prompts: string[] }`),新增/改写:

```ts
test('streams chunks into the summary and forwards each delta', async () => {
  const deltas: string[] = [];
  const { record } = await compressSession(recordWith(3), streamModel(['前情', '提要']), 1, d => deltas.push(d));
  expect(record.summary).toBe('前情提要');
  expect(deltas).toEqual(['前情', '提要']);
});
test('caps summary at COMPACT_MAX_SUMMARY_CHARS and stops consuming early', async () => {
  const pulled: number[] = [];
  const model = streamModel(['x'.repeat(1000), 'y'.repeat(1000), 'z'.repeat(1000)], { trackPulled: pulled });
  const { record } = await compressSession(recordWith(3), model, 1);
  expect(record.summary!.length).toBeLessThanOrEqual(COMPACT_MAX_SUMMARY_CHARS);
  expect(pulled.length).toBe(2); // 第三块未被消费
});
test('mid-stream error falls back with error set', async () => {
  const { compressed, record, error } = await compressSession(recordWith(3), streamModel(['前情'], { throwAt: 2 }), 1);
  expect(compressed).toBe(false); expect(error).toBeDefined(); expect(record).toBeDefined();
});
test('non-string chunk content is skipped', async () => {
  const model = { stream: async function* () { yield { content: '前情' }; yield { content: [{ text: 'x' }] }; yield { content: '提要' }; } };
  const { record } = await compressSession(recordWith(3), model as never, 1);
  expect(record.summary).toBe('前情提要');
});
```
(既有 8 个压缩用例换用 `streamModel(['提要内容'])` 等形式,断言不变)

- [ ] **Step 2: 确认失败** — `bun test src/sessions/compact.test.ts` → FAIL(stream 不存在/断言不匹配)
- [ ] **Step 3: 实现** — `COMPACT_MAX_SUMMARY_CHARS`;`compressSession` 内:`let summary = ''` + `for await (const chunk of model.stream(prompt))` 逐块取串文本、`onDelta?.(text)`、超限 `break`;循环后 `summary = summary.slice(0, COMPACT_MAX_SUMMARY_CHARS).trim()`;空 → error;catch 覆盖流中抛错
- [ ] **Step 4: 确认通过** — 同命令 → PASS
- [ ] **Step 5: Commit** — `git add src/sessions/compact.ts src/sessions/compact.test.ts && git commit -m "feat: streaming compaction with per-chunk deltas and hard char cap"`

### Task 2: REPL 流式显示 + compact 路由

**Files:**
- Modify: `src/screens/REPL.tsx`(resumeWith、/compact 分支;import `getRouting`)

**Interfaces:**
- Consumes: Task 1 全部导出;`getRouting()`(provider.js 已导出)

- [ ] **Step 1: 共享 helper** — 抽 `runCompaction(record, keepTurns): Promise<{compressed, record, error?}>`:内部统一「正在提炼前情提要…」提示 + `createModel(getRouting().compact ?? ctx.modelId).model` + `onDelta: delta => appendChatOutput(delta)` + 完成后补 `\n\n`;resumeWith 与 /compact 两入口**都只调它**,行为完全一致
- [ ] **Step 2: 两入口接线** — resumeWith 与 /compact 分支替换各自的模型构造与调用为 `runCompaction`(mock 跳过逻辑保留在 helper 内)
- [ ] **Step 3: 全量验证** — `bun test` 全绿 + `npm run typecheck` + `npm run build:repl`
- [ ] **Step 4: Commit** — `git commit -m "feat: live-stream compaction summary and compact-role fast-model routing"`
