# 忙时输入队列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 忙时用户可排队输入,回合自然结束自动逐条续发;取消/报错冻结,空回车续发,idle 单击 Esc 清空队列。

**Architecture:** 队列语义全部收进纯函数 reducer(`src/screens/input-queue.ts`,仿 turn-summary 抽离模式);REPL 只做三处接线——回车分支(入队/空回车续发)、runChat 收尾(自然结束 `turnEnded` / 取消与报错 `frozen`)、Esc 分支(清空)——加一段淡色队列渲染。

**Tech Stack:** TypeScript + Bun test(已有,零新依赖)。

**Spec:** `docs/superpowers/specs/2026-11-22-input-queue-design.md`

## Global Constraints

- 队列不持久化、不编辑单条;ACP 侧不动
- 入队认一切 busy(含 /compact、/resume 窗口);自动续发只挂聊天回合自然结束(end_turn/stalled/max_turns),`cancelled` 与 catch 报错一律 `frozen`
- Esc:idle 且队列非空 → 清空队列(不退出);队列空 → 原退出行为不变;busy → 原取消行为 + frozen
- 空白输入不入队;busy 时空回车无操作;idle 空回车且队列非空 → 续发一条
- 每任务收尾:`bun test` 全绿 + `bun run typecheck` 通过

## Review Focus

1. **空白输入 busy 回车** → 不入队(reducer 拒收空串)
2. **回合报错** → 冻结不续发,防止过期 key 连烧整条队列(REPL 接线的 catch 路径)
3. **Esc 语义矩阵**:busy=取消+冻结 / idle+队列=清空 / idle+空=退出(不再误退)
4. **取消或报错后队列滞留** → idle 空回车可逐条捞回
5. **/compact、/resume busy 窗口** → 可入队,流程结束不触发自动续发(只挂 runChat)

---

### Task 1: 队列 reducer `src/screens/input-queue.ts`

**Files:**
- Create: `src/screens/input-queue.ts`
- Test: `src/screens/input-queue.test.ts`

**Interfaces:**

```ts
export type QueueAction =
  | { type: 'enqueue'; text: string }
  | { type: 'turnEnded' }   // 自然结束:shift 首条为 submit
  | { type: 'frozen' }      // 取消/报错:原样保留(冻结态由 REPL 侧呈现)
  | { type: 'submitNext' }  // idle 空回车:同 turnEnded
  | { type: 'clear' };
export function reduceQueue(queue: string[], action: QueueAction): { queue: string[]; submit?: string };
```

- [ ] **Step 1: 写失败测试**

```ts
test('enqueue:入队尾部;空白(trim 后空)拒收')
test('turnEnded:shift 首条返回 submit 与剩余;空队列无 submit')
test('submitNext 与 turnEnded 同型')
test('frozen 原样返回;clear 清空')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/screens/input-queue.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 reducer**(纯函数,不可变更新)

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/screens/input-queue.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/screens/input-queue.ts src/screens/input-queue.test.ts
git commit -m "feat: input queue reducer with freeze and manual-resume semantics"
```

---

### Task 2: REPL 接线 + 队列渲染

**Files:**
- Modify: `src/screens/REPL.tsx`(回车分支、runChat 收尾、Esc 分支、渲染区)
- Test: 纯逻辑已由 Task 1 覆盖;本任务验证 = 全量回归 + typecheck

**Interfaces:**
- Consumes: Task 1 的 `reduceQueue`/`QueueAction`
- Produces: REPL 内部 `inputQueue` state + `dispatchQueue(action)` helper(不导出)

- [ ] **Step 1: 回车分支改造**(`key.return` 处)

原 `if (busyRef.current) return;` 改为:busy 且 trimmed 非空 → `enqueue` + `commitInput('')`;busy 且空 → 无操作;非 busy 且空且队列非空 → `submitNext`;非 busy 其余 → 原提交。同步在 `resolveSubmitInput` 门之前处理(空回车续发不能被闸门吞)。

- [ ] **Step 2: runChat 收尾挂续发**

`runChat` 内线程化 `endedNaturally`(stopReason 非 `cancelled` 且未抛错);`finally` 里 busy 复位后:自然结束 → `dispatchQueue({ type: 'turnEnded' })`,否则 `frozen`。dispatchQueue 收到 `submit` 时调 `handleSubmit(submit)`(注意重入:handleSubmit 会再次进入 runChat,队列 state 更新在前)。

- [ ] **Step 3: Esc 分支改造**

busy(现有取消路径不变,取消会经 runChat 的 cancelled → frozen);idle 且 `inputQueue.length > 0` → 清空 + 提示 `(队列已清空)` 并 return;idle 且空 → 原退出逻辑不动。

- [ ] **Step 4: 渲染**

输入框上方:`inputQueue.map(t => <Text color="gray" dimColor>⏎ {t}</Text>)`;队列非空且 !busy 时附提示行 `(queued N — Enter 续发,Esc 清空)`。

- [ ] **Step 5: 全量回归 + typecheck + 提交**

Run: `bun test && bun run typecheck`
Expected: PASS 全绿

```bash
git add src/screens/REPL.tsx
git commit -m "feat: queue prompts while busy, auto-continue after natural turn end"
```
