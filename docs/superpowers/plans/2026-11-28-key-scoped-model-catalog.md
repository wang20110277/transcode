# 按 key 圈定的模型目录(修正版)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 目录只列已配 key 通道的真实可用模型(线上拉取+通道级回退),profile 网关支持多模型 spec。

**Architecture:** `resolveModel` colon 分支加 profile 路由;`getSelectableModels()` 重写为 key 圈定同步快照;新增 `fetchSelectableModelsLive(fetcher?)` 供 agent/models 与 CLI。

**Tech Stack:** TypeScript(ESM)、bun:test、本地 Bun.serve 假网关。

**Spec:** `docs/superpowers/specs/2026-11-28-key-scoped-model-catalog-design.md`

## Global Constraints

- 无 key 通道在任何路径(线上/回退/快照)都不出现。
- session/new 与 set_model 的 availableModels 零网络。
- 不新增依赖;测试名中文;`bun test`;TDD;线上函数可注入 fetcher。

## Review Focus

1. 无 key 无网关 → 空目录不崩 — Task 2/3 测。
2. `gw1:model-a` 往返:catalog 条目 → session/new 接受 → resolve 到 gw1 baseUrl — Task 1 测。
3. 单通道线上失败只回退该通道 — Task 3 测(假网关 500 + 正常通道并存)。
4. 快照与线上目录都不含无 key 厂商 — Task 2/3 测(fixture 无 glmc key 时无 glmc 条目)。
5. 通道并行拉取,总时长 ≈ 最慢通道(不串行)— Task 3 用两个延时假网关断言总时长 < 串行和。

---

### Task 1: `profile:MODEL` spec 形态

**Files:**
- Modify: `src/provider/provider.ts`(resolveModel colon 分支、validateModelSpec)
- Test: `src/provider/provider.test.ts`

**Interfaces:**
- Produces: `resolveModel('gw1:model-a')` → profile gw1 的 baseUrl/envKey/keyId + `model: 'model-a'`;`validateModelSpec` 接受任一 baseUrl+model 齐备 profile 名作前缀。

- [ ] **Step 1: 失败测试**:fixture 写 `profiles: {gw1: {baseUrl, model: 'mb', envKey?}}` → `resolveModel('gw1:model-a')` 的 `.model === 'model-a'`、`.baseUrl === gw1.baseUrl`;裸 `'gw1'` 仍 `.model === 'mb'`;`validateModelSpec('gw1:x')` → null;不完整 profile(缺 model)作前缀 → 按 invalid 处理或落厂商分支(钉住一种)。
- [ ] **Step 2: RED** → Step 3: 实现(colon 分支先查 profile 齐备者)→ **Step 4: GREEN**
- [ ] **Step 5: 提交** `feat: profile:MODEL specs route through the profile's gateway`

### Task 2: key 圈定同步快照

**Files:**
- Modify: `src/provider/provider.ts`(getSelectableModels 重写)、`src/acp/session.ts`(modelCatalog 补 modelLabel)
- Test: `src/provider/provider.test.ts`、`src/acp/server.test.ts`

**Interfaces:**
- Produces: `getSelectableModels(): {modelId, name}[]` — 有 key 厂商的 curated 展开 + 全部网关的已配模型;无 key 厂商不出现。

- [ ] **Step 1: 失败测试**:空配置 → `[]`;`apiKeys: {glmc: 'x'}` fixture → 有 `glmc:glm-5.3-flash`、无 `deepseek:`/`opus:`/裸 `glmc`;两网关 → `gw1:mb` 与 `custom:legacy-model`(快照只展示已配模型);既有 21 条断言按 key 圈定改写(补 apiKeys fixture)。`modelCatalog` unshift 用 `modelLabel`。
- [ ] **Step 2: RED** → **Step 3: 实现**(vendor 循环加 `lookupApiKey` 门;custom 槽位经网关部分,跳过厂商循环的 custom)→ **Step 4: GREEN**(provider + acp)
- [ ] **Step 5: 提交** `feat: catalog is scoped to channels with configured keys`

### Task 3: 线上目录(agent/models + CLI)

**Files:**
- Modify: `src/provider/provider.ts`(fetchSelectableModelsLive)、`src/acp/server.ts`、`src/cli.ts`
- Test: `src/provider/provider.test.ts`、`src/acp/server.test.ts`、`src/cli.test.ts`

**Interfaces:**
- Produces: `export async function fetchSelectableModelsLive(fetchModels: typeof fetchEndpointModels = fetchEndpointModels): Promise<{modelId, name}[]>`
- `agent/models` 与 `transcode models` await 它;session 侧不动。

- [ ] **Step 1: 失败测试**(注入 fetcher):
  - 注入返回多模型 → 网关多条 `gw1:ma/gw1:mb`;无 key 厂商仍无;
  - fetcher 对某通道抛/返回空 → 该通道回退已配/curated,其余正常;
  - 两通道各延时 120ms → 总时长 < 200ms(并行);
  - server.test:agent/models 用真 fetch 但 fixture 指向本地 Bun.serve 假网关(空 key fixture,只有网关通道)→ 返回假网关模型;cli.test 同路径。
- [ ] **Step 2: RED** → **Step 3: 实现**(Promise.all 通道级组装;CLI/ACP await)→ **Step 4: GREEN**
- [ ] **Step 5: 提交** `feat: agent/models lists live gateway models for keyed channels`

### Task 4: 全量验证 + 文档

- [ ] `bun test` → 0 fail;`bun run typecheck`;`bun scripts/acp-smoke.ts`;实机 `bun bin/transcode.ts models | jq length`(真实 key 环境:glmc/deepseek + 网关)。
- [ ] ACP.md:`agent/models` 改为"线上拉取已配 key 通道,通道级回退,无 key 不显示"。提交 `docs: agent/models is live and key-scoped`
