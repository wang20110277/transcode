# 压缩保留轮数参数化(/compact、/resume)— 设计

## 意图

压缩保留的「最近 N 轮」由固定 10 改为**可传参、默认 1**,两个入口都支持。

## 用法

- `/compact` → 保留最近 1 轮;`/compact 5` → 保留最近 5 轮
- `/resume` → 选择器,Enter 后按默认 1 轮压缩;`/resume 3` → 恢复第 3 个、默认 1 轮;`/resume 3 5` → 恢复第 3 个、保留 5 轮
- 解析:第二个纯数字参数 = 保留轮数,须 ≥1;不合法(N<1 或非数字)提示用法并忽略
- 选择器路径(Enter)固定用默认值,不接参数

## 设计

- `compact.ts`:`KEEP_TURNS = 10` 改为 `DEFAULT_KEEP_TURNS = 1`;`compressSession(record, model, keepTurns = DEFAULT_KEEP_TURNS)`,内部所有窗口判断用 `keepTurns`
- REPL:恢复分支解析尾参(首参仍是会话目标,逻辑不变);`resumeWith(record, inputLine, keepTurns)`;`/compact` 分支解析首参数字;「无需压缩」提示与 oldTurnsCount 均按生效 N 计算
- 保留轮数**不持久化**到会话记录(会话记忆式方案已否)

## 非目标

- 不做 picker 内选轮数、不做配置文件项、不改摘要提示词

## 备选(已否)

- 会话记忆式(/compact 记住 N,resume 沿用):行为藏在数据里,换会话默认不同 — 用户选尾参式。
