# ACP 会话持久化 — 设计

日期:2026-11-28 · 状态:设计已确认(对应 `docs/roadmap.md` 阶段一第 2 项)

## 意图

ACP 会话现在只活在 `AcpServer.sessions` 这个进程内 Map 里(`acp/server.ts` 声明 `loadSession: false`,`session/load`/`resume` 只查内存),宿主(multica、transonce)重启 agent 进程即丢全部会话。本次让 ACP 会话走磁盘:复用 REPL 已在用的 `sessions/store.ts`,做完后进程重启可恢复,阶段一封箱。

## 现状

- 积木全齐:`store.ts` 的 `saveSession`(tmp+rename 原子写,按项目目录 `~/.transcode/sessions/<projectDir>/` 分档)、`getSession(id)`、`listSessions`;`resume.ts` 有 `listProjectSessions(cwd)`;`generateTitle`(模型生成 ≤12 字标题,失败回退截断)。
- REPL 的节奏:首轮 prompt 完成后生成标题并落盘,此后每轮结束更新。
- `AcpSession.messages` 就是 `BaseMessage[]`,store 的序列化/反序列化直接可用。
- 差异:ACP 会话 id 为 `ses_UUID`,盘上(REPL)为裸 UUID;`ToolSession` 状态(bash cwd、读后编辑守卫)不持久。

## 设计

1. **能力声明**:`initialize` 返回 `loadSession: true`。
2. **落盘节奏(与 REPL 一致)**:`session/new` 创建后**首轮 prompt 完成时**生成标题(复用 `generateTitle`,mock 模式回退)并 `saveSession`;此后每轮 prompt 结束(cancel/error 轮同样)以同一 id 更新。crash 在首轮之前则无会话可恢复,与 REPL 相同。id 沿用 `ses_UUID` 作记录 id 与文件名,前缀无碍查找。
3. **恢复**:`session/load` / `session/resume` 内存 Map 未命中时 `getSession(sessionId)` 拉盘,重建 `AcpSession`(messages 反序列化、cwd、modelSpec 取自 record.model),入 Map 后返回 `sessionNewResult`;仍无 → `-32002` sessionNotFound。
4. **`session/list`(自定义扩展)**:入参 `{ cwd }`,经 `listProjectSessions(cwd)` 返回该项目会话摘要数组(id、title、updatedAt),新→旧。
5. **`session/close`**:从活跃 Map 移除并 cancel;磁盘记录保留,可再次 load。
6. **恢复后的 `ToolSession`**:全新创建(bash cwd 回工作区根、读后编辑守卫重置)——与 REPL resume 行为对齐。
7. **记录字段**:`summary` 留空(ACP 侧暂无 compaction 产物;loop 内 autoCompact 只动内存,不落盘,维持现状)。

## 非目标

- 会话分叉与文件快照(阶段三,见 roadmap)。
- ACP 侧的 /compact 对应物。
- 跨项目会话迁移(cwd 变更后仍按原 cwd 分档)。

## 验收口径

- `session/new` + 一轮 prompt → `~/.transcode/sessions/<projectDir>/ses_*.json` 存在且含标题。
- 杀进程重启 → `session/load` 同 id 返回会话,续问能接上历史。
- `session/list` 按 cwd 只出本项目的;`session/close` 后 prompt 该 id 报 `-32002`,load 后可用。
