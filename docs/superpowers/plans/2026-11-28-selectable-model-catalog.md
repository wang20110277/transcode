# 可选模型目录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模型目录从厂商层展开为真实可选条目(厂商 curated 规格 + 自定义网关),ACP/CLI/session 三处统一。

**Architecture:** `provider.ts` 新增 `getSelectableModels()`(由现有 `VENDOR_MODELS` + `listCustomGateways()` 派生);三个消费点替换调用;目录测试随之更新。

**Tech Stack:** TypeScript(ESM)、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-28-selectable-model-catalog-design.md`

## Global Constraints

- 每个 `modelId` 必须可被 `validateModelSpec` 接受且 `resolveModel` 可解析(不新增第四种 spec 形态)。
- 不新增依赖;测试名中文;`bun test`;TDD。

## Review Focus

1. 目录条目与校验器的一致性:任取 modelId 传 `session/new` 不报 invalidParams — Task 1 测(全量遍历断言)。
2. 自定义网关多条:两个 profile + legacy custom 槽 → 三条全部出现 — Task 1 测。
3. `glm` 与 `glmc` 同名模型可区分(name 带厂商名) — Task 1 测。
4. 三处目录内容一致(agent/models、CLI、modelCatalog) — Task 1/2 测。
5. 空 curated 厂商不产生空条目;目录非空 — Task 1 测。

---

### Task 1: `getSelectableModels` + 三处切换

**Files:**
- Modify: `src/provider/provider.ts`、`src/acp/session.ts`(modelCatalog)、`src/acp/server.ts`(agent/models)、`src/cli.ts`(models)
- Test: `src/provider/provider.test.ts`、`src/acp/server.test.ts`、`src/cli.test.ts`
- Docs: spec 与本计划随本任务提交

**Interfaces:**
- Produces: `export function getSelectableModels(): { modelId: string; name: string }[]`(厂商 curated 展开 + `listCustomGateways()` 追加,按 modelId 去重)。
- `modelCatalog(currentId: string)` 改用 `getSelectableModels()`(unshift 当前 id 逻辑不变)。

- [ ] **Step 1: 写失败测试**

provider.test.ts:
- `目录展开厂商模型并去重`:`getSelectableModels()` 含 `{modelId: 'glmc:glm-5.3-flash', name: 含 'GLM Coding Plan' 与 'glm-5.3-flash'}`;**不含** modelId `'glmc'`;`glm:glm-5.3` 与 `glmc:glm-5.3` 同时在(name 各带厂商名)。
- `自定义网关多条全出现`:config fixture 写 `custom + 两个 profiles` → 三条 modelId(`custom`、`gw1`、`gw2`)全在。
- `全量条目过校验`:`for (const m of getSelectableModels()) expect(validateModelSpec(m.modelId)).toBeNull()`。

server.test.ts:`agent/models 含具体规格不含厂商裸 id`(`glmc:glm-5.3-flash` 在,`glmc` 不在)。
cli.test.ts:断言更新为 `modelId === 'glmc:glm-5.3-flash'` 在。
session 侧(server.test 或 session.test):`session/new` 返回的 `models.availableModels` 含具体规格。

- [ ] **Step 2: 跑测试确认失败** → FAIL(getSelectableModels 未导出;目录仍旧)

- [ ] **Step 3: 实现**

`getSelectableModels`:遍历 `Object.keys(MODEL_REGISTRY)`,`vendorModels(id)`(已存在)逐个 `vendorModelSpec`;再 `listCustomGateways()` 追加;Map 去重。`modelCatalog`/`agent/models`/CLI 分支换调用(name 映射不变)。

- [ ] **Step 4: 跑测试确认通过** → PASS(provider + acp + cli 三文件)

- [ ] **Step 5: 提交(含 spec+plan)** `feat: model catalog lists selectable models and custom gateways`

### Task 2: 全量验证

- [ ] `bun test` → 0 fail;`bun run typecheck`;`bun scripts/acp-smoke.ts` → passed;`bun bin/transcode.ts models | jq length` 实机抽查。
- [ ] 提交(如有测试形状修正)`test: catalog assertions follow the selectable shape`
