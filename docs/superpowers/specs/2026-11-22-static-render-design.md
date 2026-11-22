# Static 渲染架构(全场景消闪烁)— 设计

## 意图

打字、流式输出、长会话全场景消闪烁。根源:历史区与活动区同帧渲染,任何 setState(每敲一个字符、每个 delta)都整屏清除重画。修法:历史区搬进 Ink `<Static>`(每条只印一次,永不重绘),按键与流式只重绘小面积活动区——这正是 Claude Code 的架构。

## 设计

**Static 历史区**:`history` 数组渲染进 `<Static items>`;条目 **append-only,推入后不可变**(现架构里 appendChatOutput 对末条追加的写法是唯一的变形点,本设计移除它)。

**活动区 `liveOutput`**(新 string state):回合内一切输出——文本 delta、工具结果/diff、折叠摘要行、取消/报错提示——经既有 `streamAppend`(32ms 节流)写入 `liveOutput`;活动区自上而下渲染:`> 输入头` + liveOutput + liveTool 指示 + 队列 + 输入框 + 弹窗。

**回合结束**:`addHistory({ input, output: liveOutput, hiddenLines })` 一次性落入 Static,清空 liveOutput。空输出(立即取消)也落条目(含 `(cancelled)`)。

**压缩摘要流**(runCompaction 与 resume 压缩):摘要 delta 同样走 liveOutput(前缀"正在提炼前情提要…"),完成后作为一条独立历史条目落入。`applyResume` 现"确认条目先建、摘要流进末条"的模式改为:压缩期间 liveOutput 承载,完成后与确认信息合并落条目。

**回合外直写不变**:命令输出、`/search` 流程提示、模式切换横幅、updateNotice 等一次性条目仍直接 `addHistory`(无流变,Static 安全)。

**ctrl+o 从开关变动作**:Static 条目印后不可改,"切换展开已打印历史"不可行——改为按下时找**最近一条**含 `hiddenLines` 的历史,补打印展开条目(`addHistory({ input: '', output: renderExpansion(entry) })`);折叠行提示改为 `(ctrl+o 展开明细)`;`verboseTools` state 删除。`renderTurnLog` 收窄为折叠行渲染;新增 `renderExpansion(entry)`。

**/clear、/resume 重建**:setHistory 替换/清空后 Static 按新 items 全量打印(append-only 语义不变),无需特判。

## 非目标

- fork Ink / 单元格级双缓冲 diff(CCB 路线,重)
- liveOutput 跨会话保留;队列/补全弹窗变化(本就在活动区)
- 展开块的再折叠(打印即定稿)

## 备选(已否)

- 输入行 setState 节流:打字频率本就低于帧率,闪烁源于单次重绘面积而非频率 — 治不了
- 维持整帧渲染 + 仅流式节流:0.10.4 已证不彻底(打字仍闪)
- ctrl+o 保留开关语义、仅对未来回合生效:违背"展开已折叠明细"的使用动机

## 审查后裁定(builder check,实测 Ink 5.2.1 源码后)

1. **活动区尾部窗口(必做)**:回合中 liveOutput 只渲染最后 `终端行数 - 固定件(~10)` 行,顶上加 `… +M lines` 指示行;全文存 ref,回合结束完整落 Static——否则长回复每 32ms 触发 clearTerminal + 整史重画,闪烁以更糟形式回归。
2. **/clear 语义变更**:Static 印出内容无法收回(无 fullStaticOutput 重置 API)——/clear = 下方开新对话、滚动缓冲保留旧内容;清空与后续条目分属不同提交批次(同批 setHistory([])+addHistory 会静默吞条,实测确认)。
3. **Banner 迁入 Static**:留交互帧会被逐键重绘且钉在历史与输入框之间(实测)——改为首条 Static 条目。
4. **ctrl+o 逐条回走**:展开后清除该条 hiddenLines(等长变更,不触发重印);连按依次展开更早折叠回合;折叠行提示字样不可抹,接受。
5. **压缩失败**:liveOutput 半截摘要与 ⚠ 提示合并为一条落史,并清空 liveOutput(防渗入下回合)。
6. 实现注意:liveOutput 需 ref 镜像(节流 flush 同步读 state 会读到旧值);回合落地与 liveOutput 清空合并为单次提交(legacy reconciler 下两次提交会闪一帧重复尾巴)。
