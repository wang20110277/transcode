# 一步恢复会话(/resume 无参数弹选择器)— 设计

## 意图

现在恢复会话要两步:先 `/sessions` 看带序号的列表,再 `/resume 3`。目标:一条命令完成浏览+选择 —— `/resume` 不带参数直接弹出方向键选择器,Enter 恢复、Esc 取消。

## 目标

- `/resume` 无参数 → 模态选择器(复用 `model_select` 的 phase 模式)
- **选择器按当前 cwd 过滤**:只列本项目的历史会话(与保存时按目录分区对应,同 Claude Code `--resume` 的项目作用域);当前项目没有会话时提示「当前项目暂无历史对话」,不回退到全局
- ↑↓ 循环移动、Enter 恢复、Esc 取消回到输入态
- `/resume <序号|id|标题片段>` 和 `/sessions` 行为不变(`/sessions` 仍为全局列表 + 搜索)

## 非目标

- 选择器内滚动/翻页(最多显示 20 条)
- 选择器内关键词过滤、删除会话
- `/sessions` 改为按项目过滤(保持全局视图)

## 设计

- **触发**:`/resume` 无参数 → `listSessions().filter(s => s.cwd === process.cwd())` 取本项目会话(旧平铺文件靠记录里的 `cwd` 字段同样命中),非空则快照前 20 条、`setPhase('session_select')`、清空输入;为空则提示「当前项目暂无历史对话」。
- **键位**(新增 `useInput` 分支,照抄 `model_select`):↑↓ 环形移动 cursor;Enter 调共享的恢复逻辑;Esc 走现有 phase 通用取消路径。
- **恢复逻辑**:从现 `/resume` 分支抽出 `applyResume(record)`(设 conversationRef/标题/messagesRef/toolSession + 确认历史行),带参/无参两条路径共用;恢复后把 `lastSessionsRef` 同步为选择器列表,让紧随其后的 `/resume N` 序号与所见一致。
- **渲染**:镜像 `model_select` 的块 —— 顶部「恢复对话 (↑↓ 选择 · Enter 恢复 · Esc 取消)」,行格式复用 `/sessions` 的 `N. 标题 · 时间 · 模型 · N 条`,光标行 cyan + `❯`。
- **测试**:恢复目标解析逻辑(无参→选择器、数字→lastSessions 索引、id/片段→匹配)抽成纯函数,TDD 覆盖;键盘/渲染接线与 `model_select` 同标准(不单测)。

## 备选方案(已否)

- **无参直接恢复最近会话**(claude -c 式):按键最少,但选不了目标,只能回到最新;用户已选方向键选择器。
