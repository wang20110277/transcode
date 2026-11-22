# 上下文预算配置(CJK 估算 + 档案级 1M + 交互式)— 设计

## 意图

让 1M 上下文模型(GLM-5.3、DeepSeek V4 Pro)用满窗口:估算器按中文字符校准、预算按模型/档案配置、`/models` 流程内交互设置、`/compact` 可查看生效配置。现状三个痛点:估算按 4 字符/token 的英文口径(中文低估 2~3 倍)、`autoCompact.thresholdChars` 与 `TRANSCODE_COMPACT_CHARS` 两道闸各配各的、配置只能手改 JSON。

## 设计

### 1. CJK 校准估算(`src/sessions/compact.ts`)

`estimateTokens(messages)`:CJK 字符按 **1.5 字/token**、其余按 **4 字/token** 分开计数求和(权重:中日韩字符 0.67 token/字,ASCII 0.25 token/字)。`shouldAutoCompact` 语义改为 **token 预算**:`estimateTokens(messages) >= budgetTokens`(废掉现在 chars↔tokens 来回换算的口径)。

### 2. 统一预算解析(单一来源,三层回退)

新 `resolveContextTokens(modelId: string): { tokens: number; source: 'byModel' | 'global' | 'default' }`:

```
autoCompact.byModel[modelId]   // 档案/模型级,交互流程写这里
?? autoCompact.contextTokens   // 全局
?? 100_000                     // 保守默认(未知模型)
```

- 配置:`~/.transcode.json` → `autoCompact: { enabled?, contextTokens?, byModel?: Record<string, number>, keepTurns? }`
- **旧 `thresholdChars` 兼容**:存在且无 `contextTokens` 时按 `/4` 折算为 token,一次性迁移语义
- **env 兜底**:`TRANSCODE_COMPACT_TOKENS`(新)覆盖全局层;`TRANSCODE_COMPACT_CHARS`(旧)仍识别并折算——两道闸(REPL 提交前 + loop 轮内)都改读 `resolveContextTokens`,loop 不再自己读 env,预算经 `runAgentLoop` 的 `options.contextTokens` 传入(REPL 与 ACP session 两调用点都接)

### 3. `/models` 流程加一步:上下文预算

连通性测试成功后、`applyModelSwitch` 之前插入 phase `model_context`:

```
上下文预算(↑↓ 选择 · Enter 确认):
  ❯ 默认(100k)
    128k
    256k
    1M
    自定义…
```

- 选档 → 写 `autoCompact.byModel[<modelId>]`;选「默认」→ 删除该 modelId 条目;「自定义…」→ phase `model_context_custom` 输入 token 数(校验正整数)
- Esc = 跳过(保持现值)

### 4. `/compact` 无参查看生效配置

输出:当前模型、生效预算(token + 约字符数,中文口径)、来源层(byModel/global/default)、keepTurns、enabled。原 `/compact <N>` 语义不变。

## 非目标

- per-model 上下文窗口注册表(自动发现模型能力)
- 网关报错后的被动压缩(PTL reactive)
- 预算动态调整(按 usage 回报自适应)

## 备选(已否)

- 保留 chars 口径:中文校准后 token 才是稳定单位,"1M 上下文"的用户心智就是 token — 已否
- 预算写进 profiles 段:内置注册表 id(如 glmc)不在 config.profiles 里,写入需整档案覆盖,重;`byModel` 独立映射轻且对任意 modelId 生效 — 已否
- 新增 `/config` 命令:与 `/compact` 职责重叠,查配置并进 `/compact` — 已否

## 审查后裁定(builder check)

1. **byModel 键形**:用户选择的完整 spec 字符串(REPL `ctx.modelId` / ACP modelSpec 同形,如 `glmc:glm-5.3`、裸 `deepseek`)——最精确;同厂商换模型不继承预算,菜单重点即可。
2. **dispatch 子代理**(`tools/dispatch.ts` 的第三个 runAgentLoop 调用点):子代理按其角色档案模型**自行解析**预算;loop 对未传 `options.contextTokens` 的调用方跳过轮内闸。
3. **优先级链**:`byModel[spec]` > `TRANSCODE_COMPACT_TOKENS` > `autoCompact.contextTokens` > `100_000`;env 压全局层但不压 byModel(交互式按模型选择是更强意图);`COMPACT_TOKENS` 与旧 `COMPACT_CHARS` 并存时新胜旧;来源枚举为 `'byModel' | 'env' | 'global' | 'default'`。
4. **`enabled: false` 同时关闭两道闸**(REPL 提交前 + loop 轮内 + ACP/子代理),开关语义唯一;`contextTokens/byModel 值为 0` 作为按模型/全局关闸暗门保留。
5. **旧 `thresholdChars`**:读时按 `/4` 折算为 token 层别名,永不写回(loadConfig 保持纯函数,不做写迁移)。
6. **loop 闸换用 `estimateTokens`**(CJK 版,token 对 token 比较),比较统一为 `>=`;loop 旧 `TRANSCODE_COMPACT_CHARS` 测试场景迁移到新链路。
