# 上下文预算配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1M 窗口模型用满预算:CJK 校准估算 + 三层预算解析(byModel/env/global/默认)+ `/models` 流程交互选档 + `/compact` 查看生效配置。

**Architecture:** 估算与解析收进 `sessions/compact.ts` + `config.ts` 纯函数;`runAgentLoop` 新增 `options.contextTokens`(不传则跳过轮内闸),REPL/ACP/dispatch 三个调用点各自解析传入;`/models` 状态机在连通测试后插 `model_context` 档位选择。spec 六条裁定为硬约束。

**Tech Stack:** TypeScript + Bun test(零新依赖)。

**Spec:** `docs/superpowers/specs/2026-11-22-context-budget-design.md`(含 6 条裁定)

## Global Constraints

- 优先级链:`byModel[spec]` > `TRANSCODE_COMPACT_TOKENS` > `autoCompact.contextTokens` > `100_000`;env 不压 byModel;旧 `TRANSCODE_COMPACT_CHARS` 折算 `/4` 后进 env 层(新 env 优先)
- 旧 `thresholdChars`:读时 `/4` 折算别名,永不写回
- `enabled: false` 关闭全部三道闸;`contextTokens/byModel === 0` 为按层关闸暗门(仍受 enabled 总开关管)
- 估算:CJK 字符 0.67 token/字,其余 0.25 token/字;两闸统一 `estimateTokens >= tokens`
- loop 未传 `options.contextTokens` → 跳过轮内闸(dispatch 角色模型自解析后传入)
- 每任务收尾:`bun test` 全绿 + `bun run typecheck` 通过

## Review Focus

1. **解析链边界**:byModel 压 env、env 压 global、thresholdChars 别名、双 env 并存、0 暗门、enabled 总闸(Task 1)
2. **CJK 估算值域**:1500 个中文字 ≈ 1000 token;4000 ASCII ≈ 1000;混合文本线性可加(Task 1)
3. **loop 闸行为**:超预算触发轮内压缩、未传跳过、旧 TRANSCODE_COMPACT_CHARS 测试迁移(Task 2)
4. **三调用点**:REPL(ctx.modelId)/ ACP(modelSpec)/ dispatch(角色档案)各自解析正确键(Task 2)
5. **/models 选档**:写对 spec 键;「默认」删条目;自定义非法输入兜底;Esc 跳过(Task 3)
6. **/compact 无参视图**:实时反映当前模型与来源层(Task 3)

---

### Task 1: CJK 估算器 + 预算解析器

**Files:**
- Modify: `src/sessions/compact.ts`(estimateTokens 重写、shouldAutoCompact 改 token 口径、新增 resolveContextTokens)
- Modify: `src/config.ts`(AutoCompactConfig 加 contextTokens/byModel、normalize 折算别名、writeContextTokens)
- Test: `src/sessions/compact.test.ts`、`src/config.test.ts`

**Interfaces:**

```ts
// compact.ts
export function estimateTokens(messages: BaseMessage[]): number;   // CJK 0.67/字,其余 0.25/字
export function shouldAutoCompact(messages: BaseMessage[], cfg: { contextTokens: number }): boolean; // >= 比较
export interface ContextBudget { tokens: number; source: 'byModel' | 'env' | 'global' | 'default'; enabled: boolean }
export function resolveContextTokens(modelId: string, env: Record<string, string|undefined> = process.env, config = loadConfig()): ContextBudget;
// config.ts
export interface AutoCompactConfig { enabled?: boolean; contextTokens?: number; byModel?: Record<string, number>; keepTurns?: number; thresholdChars?: number /* 旧别名 */ }
export function writeContextTokens(modelId: string, tokens: number | null): void; // null=删条目,写 autoCompact.byModel
```

- [ ] **Step 1: 写失败测试**(compact.test.ts:CJK/ASCII/混合估算、shouldAutoCompact token 比较、resolveContextTokens 全链矩阵;config.test.ts:normalize 折算别名、writeContextTokens 增删改不覆盖其它段)
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**(resolveContextTokens 读 config.autoCompact,链:byModel → env TOKENS → env CHARS/4 → contextTokens → thresholdChars/4 → 100_000;enabled 从 config.autoCompact.enabled ?? true)
- [ ] **Step 4: 跑测试确认通过 + 全量回归**(REPL 旧调用 shouldAutoCompact 处需同步最小适配,阈值行为等价换算)
- [ ] **Step 5: 提交** `feat: cjk-aware token estimate and layered context budget resolution`

---

### Task 2: loop 闸迁移 + 三调用点接线

**Files:**
- Modify: `src/agent/loop.ts`(options.contextTokens、闸改 estimateTokens、删 env 直读与 estimateMessagesChars)
- Modify: `src/screens/REPL.tsx`(runChat options + autoCompactIfNeeded 改用 resolveContextTokens)
- Modify: `src/acp/session.ts`(runAgentLoop options)
- Modify: `src/agent/tools/dispatch.ts`(角色档案预算解析传入)
- Test: `src/agent/loop.test.ts`(迁移 + 新增)

**Interfaces:**
- Consumes: Task 1 全部
- Produces: `AgentLoopOptions.contextTokens?: number`(undefined = 跳过轮内闸)

- [ ] **Step 1: 写失败测试**(loop:传 contextTokens 超限触发轮内压缩、未传跳过;旧 TRANSCODE_COMPACT_CHARS 用例迁移为 contextTokens 参数)
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**(loop 闸:`options.contextTokens !== undefined && estimateTokens(messages) >= options.contextTokens`;REPL/ACP:enabled 时传 `resolveContextTokens(spec).tokens`,disabled 传 undefined;dispatch:按角色档案模型解析)
- [ ] **Step 4: 全量回归 + typecheck**
- [ ] **Step 5: 提交** `feat: unified context-budget gate across repl, acp and subagents`

---

### Task 3: /models 预算档 + /compact 查看 + README

**Files:**
- Modify: `src/screens/REPL.tsx`(phase `model_context`/`model_context_custom`、/compact 无参视图)
- Modify: `README.md`(配置说明:contextTokens/byModel、/models 选档、/compact 新语义、旧字段兼容)
- Test: `src/config.test.ts`(writeContextTokens 已覆)、`src/commands.test.ts`(/compact 桩文案)

**Interfaces:**
- Consumes: Task 1 `writeContextTokens`/`resolveContextTokens`
- Produces: PromptPhase 增 `model_context | model_context_custom`(REPL 内部);`/compact` 无参 = 配置视图

- [ ] **Step 1: 写失败测试**(/compact 桩注册与说明;菜单档位数据纯函数 `CONTEXT_BUDGET_CHOICES` 含 label→tokens 映射)
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**(连通测试成功后进 `model_context`:默认(100k)/128k/256k/1M/自定义…;Enter 写 writeContextTokens(spec, tokens|null) 后 applyModelSwitch;Esc 直接 applyModelSwitch 保持现值;自定义 phase 校验正整数,非法提示重输;/compact 无参输出:模型 spec、生效 tokens、约字符数(×4 显示)、来源层中文、keepTurns、enabled;`/compact <N>` 不变)
- [ ] **Step 4: 全量回归 + typecheck**
- [ ] **Step 5: 提交** `feat: interactive context budget picker and /compact config view`
