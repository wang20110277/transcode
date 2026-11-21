# 压缩保留轮数参数化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/compact [N]` 与 `/resume [target] [N]` 可指定压缩保留的最近轮数,默认 1 轮。

**Architecture:** `compressSession` 增加第三参 `keepTurns`(默认 `DEFAULT_KEEP_TURNS = 1`),新增纯函数 `parseKeepCount` 校验参数;REPL 两条恢复路径与 /compact 接线;核心逻辑 TDD。

**Tech Stack:** TypeScript、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-21-keep-turns-param-design.md`

## Global Constraints

- `DEFAULT_KEEP_TURNS = 1`(替代 `KEEP_TURNS = 10`)
- `/resume` 首参仍是会话目标(现有解析不变);第二个纯数字参数 ≥1 才生效,非法(0/负数/非数字)提示用法并按默认执行
- 保留轮数不持久化
- 其余行为(滚动合并、失败回退、原子写、前情提要注入)不动

## Review Focus

- 默认值语义:>1 轮会话默认压缩到只剩 1 轮(Task 测试:default keeps 1)
- `/resume 3 0`、`/resume 3 abc`:用法提示 + 按默认执行,不崩(parseKeepCount 测试)
- 显式大窗口仍可用:`compressSession(rec, model, 10)` 保留 10 轮(Task 测试)
- picker Enter(无参路径)用默认 1(接线,复用现有 DEFAULT 导入)
- 「无需压缩」提示与「旧 N 轮」计数按生效 N 计算(接线)

---

### Task 1: keepTurns 参数化(核心 + 接线)

**Files:**
- Modify: `src/sessions/compact.ts`、`src/sessions/compact.test.ts`、`src/screens/REPL.tsx`(resume 分支、resumeWith、/compact 分支)

**Interfaces:**
- Produces:
  - `export const DEFAULT_KEEP_TURNS = 1`
  - `compressSession(record, model, keepTurns = DEFAULT_KEEP_TURNS)`(内部窗口判断全用 keepTurns,`Math.max(1, keepTurns)` 防御)
  - `parseKeepCount(raw: string | undefined): { keep?: number; error?: string }` — undefined→`{}`;`/^\d+$/` 且 ≥1→`{keep:N}`;否则→`{error:'保留轮数需为 ≥1 的整数,已按默认 N 轮执行'}`(N 为默认值)

- [ ] **Step 1: 失败测试**(compact.test.ts 重写压缩用例并新增)

```ts
test('default keeps only 1 turn', async () => {
  const { compressed, record } = await compressSession(recordWith(3), mockModel('提要'));
  expect(compressed).toBe(true);
  expect(splitTurns(record.messages).turns.length).toBe(1);
});
test('explicit keepTurns=10 keeps 10', async () => {
  const { record } = await compressSession(recordWith(12), mockModel('提要'), 10);
  expect(splitTurns(record.messages).turns.length).toBe(10);
});
test('keepTurns below 1 clamps to 1', async () => {
  const { record } = await compressSession(recordWith(3), mockModel('提要'), 0);
  expect(splitTurns(record.messages).turns.length).toBe(1);
});
describe('parseKeepCount', () => {
  test('undefined → default; "5" → 5; "0"/"abc" → error, no keep', () => {
    expect(parseKeepCount(undefined)).toEqual({});
    expect(parseKeepCount('5')).toEqual({ keep: 5 });
    expect(parseKeepCount('0').keep).toBeUndefined();
    expect(parseKeepCount('0').error).toBeDefined();
    expect(parseKeepCount('abc').error).toBeDefined();
  });
});
```
(既有「≤KEEP_TURNS no-op」用例改为显式传 10;rolling merge / truncation / failure 用例传 10 保持原语义)

- [ ] **Step 2: 确认失败** — `bun test src/sessions/compact.test.ts` → FAIL(KEEP_TURNS/parseKeepCount 不存在)
- [ ] **Step 3: 实现** — `DEFAULT_KEEP_TURNS = 1`;`compressSession` 第三参与钳制;`parseKeepCount` 按接口注释
- [ ] **Step 4: 确认通过** — 同命令 → PASS
- [ ] **Step 5: REPL 接线** — import 改 `DEFAULT_KEEP_TURNS`;resume 分支:`parseKeepCount(args[1])`,error 则 addHistory 提示,keep 传入 `resumeWith(record, trimmed, keep)`;`resumeWith(record, inputLine, keepTurns = DEFAULT_KEEP_TURNS)` 内部判断与 `oldTurns = turns.length - keepTurns` 全部改用参数;picker Enter 调 `resumeWith(record, '/resume')` 走默认;`/compact` 分支:`parseKeepCount(args[0])` 同规则,「无需压缩(当前 X 轮 ≤ N)」与 oldTurnsCount 用生效 N
- [ ] **Step 6: 全量验证** — `bun test` 全绿 + `npm run typecheck` + `npm run build:repl`
- [ ] **Step 7: Commit** — `git add src/sessions/compact.ts src/sessions/compact.test.ts src/screens/REPL.tsx && git commit -m "feat: parameterizable keep-turns for /compact and /resume (default 1)"`
