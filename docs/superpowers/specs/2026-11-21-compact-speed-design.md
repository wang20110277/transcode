# 压缩提速(流式 + 快速模型路由 + 硬上限)— 设计

## 意图

压缩慢的两个根源:阻塞式 `invoke()` 全程无反馈(感知慢)、用当前推理模型烧思考 token(真慢)。对齐 Claude Code 的做法:流式展示、可路由快速模型、输出硬上限。

## 设计

- **流式**:`CompactModel` 接口从 `{ invoke }` 改为 `{ stream(input): AsyncIterable<{content}> }`;`compressSession(record, model, keepTurns, onDelta?)` 逐块累积摘要,`onDelta(块文本)` 回调供 REPL 实时打进聊天区(先显示「正在提炼前情提要…」再流式输出)。流中抛错/空结果 → 原有失败回退语义不变
- **字符硬上限**:`COMPACT_MAX_SUMMARY_CHARS = 1200`,累积超限即停止消费流(provider 无关的输出钳制,替代依赖各厂商 maxTokens 参数)
- **快速模型路由**:压缩调用用 `createModel(getRouting()['compact'] ?? 当前模型)` —— 在 `~/.transcode.json` 的 `routing` 里配 `"compact": "<快速模型>"`(如 glm-4.6-air / deepseek-chat)即可换快模型;未配置则维持当前模型(流式 + 上限仍生效)
- 测试:mock 改为 async generator;新增流式累积、超限截断、流中报错、onDelta 传递用例

## 非目标

- 不做 prompt-cache 复用(单请求形态不同)、不做增量边界总结(数据模型不同)、不引入 <summary> 八段式(后续可单独迭代)

## 备选(已否)

- per-call maxTokens 参数:LangChain 跨厂商 bind 参数行为不一,字符上限更可靠
- 默认硬编码快速模型:用户 key/厂商各异,routing 显式配置更诚实
