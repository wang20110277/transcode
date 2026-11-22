# Static 渲染架构迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 历史区迁入 Ink `<Static>`(只印一次),活动区(输入/队列/流式尾部窗口)小面积重绘——全场景消闪烁。

**Architecture:** 回合内一切输出写入 `liveOutput`(经既有 32ms 节流),活动区只渲染其**尾部窗口**(rows-10 行 + `… +M lines` 指示);回合结束**单次提交**落地 Static 条目并清空 liveOutput。`history`+`liveOutput` 合并为单一 state(legacy reconciler 下两次提交会闪一帧重复尾巴,spec 裁定 #6)。

**Tech Stack:** TypeScript + Bun test;Ink 5 `<Static>`(已装,零新依赖)。

**Spec:** `docs/superpowers/specs/2026-11-22-static-render-design.md`(含 6 条审查裁定,均为约束)

## Global Constraints

- Static 语义(Ink 5.2 实测):纯按 `items.length` 增量打印;**条目推入后不可变**(等长变更不重印,可利用——ctrl+o 清 hiddenLines);同批 `setItems([])`+append 会吞条
- 活动区高度必须 < 终端行数(否则触发 clearTerminal+整史重画):liveOutput 尾部窗口 `rows - 10`,`… +M lines` 指示行
- 回合落地 = **单次提交**(合并 state);liveOutput 带 ref 镜像(节流 flush 同步读)
- /clear:清空与确认条目**分批提交**(setTimeout 0);语义 = 下方开新对话(滚动缓冲保留)
- Banner = 首条 Static 条目(不留在交互帧)
- ctrl+o = 动作:展开最近含 hiddenLines 的条目(连按回走),展开后清该条 hiddenLines
- 每任务收尾:`bun test` 全绿 + `bun run typecheck` 通过

## Review Focus

1. **长回复超终端高度** → 尾部窗口使活动区恒 < rows,不触发整史重画(Task 1/2)
2. **/clear 同批吞条** → 确认条目分批提交(Task 3)
3. **回合落地重复尾巴帧** → 合并 state 单提交(Task 2)
4. **压缩失败** → 半截摘要 + ⚠ 合并一条落史,liveOutput 清零不渗下回合(Task 2)
5. **ctrl+o 连按** → 逐条回走,已展开条目不再重复(Task 3)
6. **resume 重建** → 全量 append 打印;压缩摘要走 liveOutput 后落条目(Task 2/3)

---

### Task 1: 纯函数层(turn-summary 改造 + 尾部窗口)

**Files:**
- Modify: `src/screens/turn-summary.ts`(`renderTurnLog` → `renderCollapsed`;新增 `renderExpansion`)
- Create: `src/screens/live-view.ts`(`sliceLiveTail`)
- Test: `src/screens/turn-summary.test.ts`(改造)、`src/screens/live-view.test.ts`

**Interfaces:**

```ts
// turn-summary.ts
export function renderCollapsed(summary: string, hiddenLines: string[]): string;
// summary + '\n… +N lines (ctrl+o 展开明细)'(hiddenLines 空则原样)
export function renderExpansion(entry: { output: string; hiddenLines: string[] }): string;
// '⚙ 展开明细:' + hiddenLines 全量(无 collapse 提示)
// live-view.ts
export function sliceLiveTail(text: string, maxLines: number): { visible: string; hidden: number };
// 末 maxLines 行;hidden = 被截行数(按非空行计?——按真实行数 split('\n') 计,含空行)
```

- [ ] **Step 1: 写失败测试**(`renderCollapsed`/`renderExpansion`/`sliceLiveTail` 各行为:计数、边界 maxLines≥总行、空文本),同时改造 turn-summary.test.ts 里 `renderTurnLog` 的三个用例为新 API
- [ ] **Step 2: 跑测试确认失败**(新 API 不存在)
- [ ] **Step 3: 实现**;`renderTurnLog` 删除(verbose 开关语义废弃)
- [ ] **Step 4: 跑测试确认通过 + 全量回归**(REPL 尚未用新 API——先改 turn-summary 会破 REPL 编译?不会:REPL 引用 renderTurnLog,删除即破——**本任务同步把 REPL 内 renderTurnLog 调用点改为 renderCollapsed(折叠行创建时)**,渲染仍走旧 history.map,行为等价)
- [ ] **Step 5: 提交** `feat: collapsed-line and live-tail pure helpers for static render`

---

### Task 2: 核心迁移(liveOutput + Static + 回合生命周期 + 压缩流)

**Files:**
- Modify: `src/screens/REPL.tsx`(state 合并、事件路由、Static 渲染、runChat/runCompaction 生命周期)
- Test: 全量回归 + typecheck(纯逻辑在 Task 1;本任务为架构接线)

**Interfaces:**
- Consumes: Task 1 全部;`createStreamThrottler`(既有)
- Produces: REPL 内部 `chat` 合并 state 与 helpers(`addHistory`/`appendLive`/`landTurn`,签名不变处沿用旧名)

- [ ] **Step 1: 合并 state**:`{ history, liveOutput }` 单 useState + `liveOutputRef` 镜像;`streamAppend` 节流目标从 appendChatOutput 改为 appendLive(写 liveOutput)
- [ ] **Step 2: 回合生命周期**:runChat 开头不再建宿主条目(输入头进活动区);结束在 finally 单次提交落地 `addHistory({input: display, output: liveOutputRef.current(+hiddenLines/摘要), hiddenLines})` 并清 liveOutput;取消/报错文案同入 liveOutput(既有 streamAppend 路径);压缩摘要流(runCompaction)走 liveOutput,成功/失败(合并 ⚠)各自落一条并清零
- [ ] **Step 3: 渲染**:`<Static items={history>` 为首子(条目渲染 = input 头 + output 纯文本,折叠提示已烙进 output);活动区:`> 输入头(busy 时)` + `sliceLiveTail(liveOutput, rows-10)` + `… +M lines` + liveTool + 队列 + 输入框 + 弹窗;删除旧 history.map 与 verboseTools
- [ ] **Step 4: resume 压缩摘要同走 liveOutput**;`applyResume` 的末条追加模式改为 liveOutput 承载 + 落条目
- [ ] **Step 5: 全量回归 + typecheck + 提交** `feat: static history with live-region streaming and tail window`

---

### Task 3: 边缘语义(Banner/clear/ctrl+o)+ README

**Files:**
- Modify: `src/main.tsx`(Banner 移出树,文本经 prop)、`src/screens/REPL.tsx`(seed 首条、/clear 分批、ctrl+o 动作)、`README.md`(ctrl+o 与 /clear 新语义)
- Test: `src/screens/turn-summary.test.ts` 或新增小测试(ctrl+o 选择的纯函数若有);其余全量回归

**Interfaces:**
- Consumes: Task 1 `renderExpansion`
- Produces: REPL prop `banner: string`(main.tsx 传入,REPL 初始化 history[0] = banner 条目)

- [ ] **Step 1: Banner 入 Static**:main.tsx 去掉 `<Banner>` 包裹,banner 文本作 prop;REPL 初始 history seed 该条目(仅挂载时)
- [ ] **Step 2: /clear**:setChat 清空后,确认条目 `setTimeout(0)` 分批提交;README 更新语义(滚动缓冲保留)
- [ ] **Step 3: ctrl+o**:handler 找最后含 hiddenLines 条目 → land 展开条目(renderExpansion)→ 同提交内清该条 hiddenLines(等长变更);README 更新
- [ ] **Step 4: 全量回归 + typecheck + 提交** `feat: banner-in-static, deferred /clear confirmation, ctrl+o expand action`
