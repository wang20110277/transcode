# 忙时输入队列(busy-input queue)— 设计

## 意图

agent 工作时用户可以继续打字并回车排队,回合结束后自动逐条接续——对齐 Claude Code 的"边生成边输入"。现状:忙时回车直接丢弃(`REPL.tsx` 的 `busyRef` 拦截),用户只能干等或 Esc 取消。

## 设计

**队列状态机**(纯函数 reducer,`src/screens/input-queue.ts`,可测):

```ts
export type QueueAction =
  | { type: 'enqueue'; text: string }   // busy 时回车入队
  | { type: 'turnEnded' }               // 聊天回合自然结束(end_turn/stalled/max_turns)→ 续发一条
  | { type: 'frozen' }                  // Esc 取消或回合报错 → 队列冻结保留
  | { type: 'submitNext' }              // idle 空回车 → 续发一条(冻结后手动恢复)
  | { type: 'clear' };                  // idle 下 Esc 清空队列
export function reduceQueue(queue: string[], action: QueueAction): { queue: string[]; submit?: string };
```

**入队**:idle phase 且 busy 时回车 → trimmed 输入入队、清空输入框;非 busy 走现有提交路径不变。

**续发**:回合**自然结束**(end_turn / stalled / max_turns 等)→ 自动 shift 一条 `handleSubmit`;**Esc 取消或回合报错都不自动续发**(取消=改主意;报错=连烧整条队列没有意义),队列冻结并提示 `(queued N — Enter 续发,Esc 清空)`,idle 时空回车续发下一条。

**Esc 清空**:idle 且队列非空时,单击 Esc = 清空队列(对齐 mention/斜杠弹窗的 Esc 关闭惯例);队列空时 Esc 仍为退出程序——原有退出行为只在无队列时保留。

**busy 的口径**:入队认一切 busy(含 /compact、/resume 压缩窗口,此时打的字正是要排队的);自动续发只挂在**聊天回合**的自然结束上,压缩/恢复流程结束不触发(避免把 handleSubmit 插进恢复的渲染中缝),滞留条目由空回车或下一回合结束捞走。

**渲染**:输入框上方淡色列表,每条 `⏎ <text>`;队首不展示输入框重复。

**命令**:斜杠命令照常入队,续发时经正常 dispatch(本地执行,快)。

## 非目标

- 队列条目编辑/删除单条(入了队就是定稿)
- 队列持久化(重启丢弃)
- ACP 侧(宿主自己管理输入时序)
- 后台并行 agent 任务(那是 C,后续大版本)

## 备选(已否)

- 单条 pending(只存最新):CC 是多深度,排队多条是常态需求 — 已否
- Esc 取消后也自动续发:与"取消=改主意"语义冲突,取消瞬间续发用户来不及反应 — 已否
- 报错回合自动续发:持续性错误(过期 key/断网)会连烧整条队列 — 已否,冻结
- 双击 Esc(500ms 窗口)清空:计时窗口复杂且首按有误退风险;单击清空 + 空队列才退出更简、且对齐弹窗 Esc 惯例 — 已否
- 取消后把队首移回输入框可编辑:状态机复杂化,空回车续发已够用 — 已否
