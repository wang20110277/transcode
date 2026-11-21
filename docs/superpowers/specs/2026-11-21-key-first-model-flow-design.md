# 先输 key 再选模型 — 设计

日期：2026-11-21 · 状态：已确认（会话内）

## 意图

内置厂商的 /models 流程改为"key 优先"：首次使用先输 key，再展示**线上实时**模型列表，避免首次用户只看到可能过期的 curated 兜底。对齐 custom 网关流程已有的顺序（baseurl → key → live 列表）。

## 行为

```
/models → 选厂商（非 custom）
  ├─ 已存 key → 直接进模型列表（实时拉取，现行为不变）
  └─ 无 key   → 先提示 apikey> → 用该 key 拉实时列表 → 选模型
```

- 首次输入的 key 只存内存草稿，`applyModelSwitch` 验证通过才落盘（Esc 中途退出不留未验证 key）
- 选完模型：若 key 是本流程刚输的 → 直接验证（不重复问）；老用户 → 保留现有"回车沿用"确认步（key 轮换入口不丢）
- 实时拉取失败/超时 → curated 兜底 + 提示行"（本地列表 · 保存 key 后显示线上实时列表）"

## 同批打磨项

- A 新者优先排序：`listEndpointModels` 按版本号降序（数值段逐位比较，同版本基础名在前）
- B 切换提示：verify 探测到的实际模型与所选不符时，切换行追加"（实际生效 X）"；`verifyModel` 返回值新增 `served` 字段
- C 兜底提示：`model_pick` 显示 curated 时标注本地列表来源

## 测试

- A：model-list.test.ts 断言代表性集合的新者排序
- B：provider.test.ts 断言 `served` 返回与提示组合
- 流程重排为 REPL 状态机改动，靠 typecheck + 全套回归 + 手动验证
