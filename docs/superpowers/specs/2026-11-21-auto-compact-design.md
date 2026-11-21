# 自动压缩(每轮提交前阈值检查)— 设计

## 意图

对齐 Claude Code 的 proactive autocompact:会话进行中每轮提交前检查上下文占用,超阈值自动压缩,避免长会话撞上下文上限。与恢复压缩、`/compact` 三路归一(同一个 `runCompaction`)。

## 设计(参考 claudecode/src/services/compact/autoCompact.ts)

- **检查点**:每次提交聊天消息时(`handleSubmit` 在进入 agent loop 之前),估算 `messagesRef` 总量,超阈值先压缩再继续本轮
- **估算**:纯函数 `estimateTokens(messages) = 全部消息文本长度 / 4`(CC 同款粗估,chars≈4/token)
- **阈值**:`autoCompact.thresholdChars`(默认 **200_000** 字符 ≈ 50k token —— 多厂商无窗口注册表,取保守值;128k 窗口模型够用,32k 模型也不会先撞墙),命中即压缩
- **配置**:`~/.transcode.json` 的 `autoCompact?: { enabled?: boolean; thresholdChars?: number }`,`normalizeAutoCompact` 容错(仿 `normalizeAutoUpdate`:坏配置回落默认,**默认开启**)
- **压缩参数**:keepTurns 用 `DEFAULT_KEEP_TURNS`(=1,与两入口一致的「一套逻辑」);失败回退语义不变
- **熔断器**:`useRef` 记连续失败次数,**连续 3 次停止自动压缩**(CC 同款,真实事故换来的),成功即复位;自动失败提示仅首次显示,后续静默(CC:自动失败不打扰)
- **显示**:压缩前先落一条空宿主条目,流式摘要照常打进聊天区,完成后 `transcriptEntries` 渲染窗口(与 /compact 同款)
- **跳过**:无进行中会话(首轮)、`TRANSCODE_MOCK=1`、已 busy、压缩中重入

## 非目标

- 不做 per-model 上下文窗口注册表、microcompact(工具结果修剪)、reactive(PTL 错误后被动压缩)、阻塞上限/警告分层 —— 有 per-model 窗口数据后再上

## 备选(已否)

- 默认关闭待配置:用户点明参考 CC(CC 默认开启)— 默认开
- 按轮数触发(如每 20 轮):轮长差异大,token 估算更贴近 CC 语义
