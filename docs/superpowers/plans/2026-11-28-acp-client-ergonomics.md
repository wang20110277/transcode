# ACP 宿主易用性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TransOnce 反馈四件套——免会话模型枚举(ACP+CLI)、session/new 模型校验拒绝静默回退、SIGTERM 退出行、`error: ` stderr 机器可读约定。

**Architecture:** 校验逻辑放 `provider.ts`(`validateModelSpec`,前缀集合从现有注册表派生);`AcpServer.handleRequest` 外包一层 try/catch 统一写 `error: ` stderr 行;`agent/models` 与 CLI `models` 都走 `getAvailableModels()`。

**Tech Stack:** TypeScript(ESM)、bun:test、内存流 JsonRpcTransport(沿用 server.test.ts 的 makeServer)。

**Spec:** `docs/superpowers/specs/2026-11-28-acp-client-ergonomics-design.md`

## Global Constraints

- stderr 错误行格式逐字:`error: <message>`(行首即 `error: `);stdout 绝不写非 JSON-RPC 内容。
- 校验只到**前缀/注册表/profile 级**,不校验模型名(厂商目录会过期)。
- `params.model` 为空白串视为未提供,走默认,不报错。
- 不新增依赖;测试名中文;`bun test`;TDD。

## Review Focus

1. `model: "  "`(空白)→ 不报错、走默认 — Task 1 测。
2. profile 名与注册表 id 同名 → 校验与 resolveModel 同序(profile 优先)均接受 — Task 1 测(config fixture 建 profile)。
3. `agent/models` 在 `initialize` 之前调用也能返回(无状态依赖)— Task 2 测。
4. `error:` 行只进 stderr,stdout 帧通道不被污染 — Task 1 测(stdout spy)。
5. `transcode models` 输出**恰好一行** JSON(无 banner/多余行),`JSON.parse` 可解析 — Task 2 测。

---

### Task 1: validateModelSpec + session/new 校验 + error: stderr 约定

**Files:**
- Modify: `src/provider/provider.ts`、`src/acp/server.ts`
- Test: `src/provider/provider.test.ts`、`src/acp/server.test.ts`
- Docs: spec 与本计划随本任务首次提交

**Interfaces:**
- Produces:
  - `export function validateModelSpec(spec: string): string | null`(`null`=合法;否则中文错误消息)。合法 = 注册表 id / `loadConfig().profiles` 名 / `已知前缀:model`(前缀 ∈ `Object.keys(MODEL_REGISTRY) ∪ Object.keys(PROVIDER_DEFAULTS)`)。
  - `AcpServer.handleRequest` 异常路径副作用:抛 RpcError 前 `process.stderr.write(\`error: ${message}\n\`)`。

- [ ] **Step 1: 写失败测试**

provider.test.ts 追加:
- `validateModelSpec 合法拼法`:`'glmc'`、`'glmc:glm-5.3-flash'`、`'opus'`、`'openai:gpt-4o'` → null。
- `validateModelSpec 非法拼法`:`'glmz:x'`、'`nope`' → 非-null 消息(含 "invalid model")。
- `profile 名合法`:TRANSCODE_CONFIG_PATH fixture 写 `{"profiles":{"mygw":{"baseUrl":"http://x","model":"m"}}}` → `'mygw'` → null。

server.test.ts 追加(复用 makeServer):
- `session/new 无效 model → invalidParams + error: stderr 行`:spy `process.stderr.write`;`session/new {cwd, model:'glmz:x'}` → `frame.error.code === -32602`、消息含 `invalid model id`;stderr spy 捕到以 `error: ` 开头且含 `invalid model id` 的行;测后还原 spy。
- `session/new 空白 model 视为未提供`:`{model: '  '}` → 正常创建。
- `合法 spec 照常创建`:`{model: 'glmc:glm-5.3-flash'}` → 正常。

- [ ] **Step 2: 跑测试确认失败** → FAIL(validateModelSpec 未导出;无效 model 仍静默创建)

- [ ] **Step 3: 实现**

`validateModelSpec`:trim;空白返回 null(未提供语义由调用方处理——此处返回 null);无冒号 → 注册表 id 或 profile 名;有冒号 → 前缀在派生集合内。`createSession`:`params.model` 为非空串时校验,非法抛 `RpcError(RPC_ERRORS.invalidParams, \`invalid model id: ${spec}(可用模型见 agent/models)\`)`。`handleRequest` 整体 try/catch:catch 里 `RpcError` → stderr 行后 rethrow;非 RpcError 包装成 internalError 前同样 stderr。

- [ ] **Step 4: 跑测试确认通过** → PASS(provider + server 两文件)

- [ ] **Step 5: 提交(含 spec+plan)** `feat: session/new validates model ids; ACP errors log error: lines`

### Task 2: agent/models + transcode models

**Files:**
- Modify: `src/acp/server.ts`、`src/cli.ts`(USAGE 补一行)
- Test: `src/acp/server.test.ts`、`src/cli.test.ts`(新建,或并入现有最近测试文件若无则新建)

**Interfaces:**
- Produces: ACP 方法 `agent/models` → `{ models: Array<{ modelId: string; name: string }> };`CLI `runCli(['models'])` → stdout 一行 JSON(同数组)。

- [ ] **Step 1: 写失败测试**

server.test.ts:
- `agent/models 免初始化直接可用`:新 makeServer 后第一笔调用即 `agent/models` → `result.models` 数组含 `modelId: 'glmc'`。
cli 侧:
- `transcode models 输出一行可解析 JSON`:spy `process.stdout.write` 收集;`await runCli(['models'])` → 拼接输出恰一行、`JSON.parse` 得数组且含 `'glmc'`;测后还原 spy。

- [ ] **Step 2: 跑测试确认失败** → FAIL(method not found / CLI 无此分支)

- [ ] **Step 3: 实现**

server.ts switch 加 `case 'agent/models': return { models: getAvailableModels().map(m => ({ modelId: m.id, name: m.name })) };`。cli.ts 加 `if (command === 'models')` 分支(在 acp 之前),`process.stdout.write(JSON.stringify(...) + '\n')`;USAGE 补行。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `feat: agent/models ACP method and transcode models CLI`

### Task 3: SIGTERM/SIGINT 退出行 + 文档

**Files:**
- Modify: `src/acp/server.ts`(runAcpServer 的 shutdown)、`docs/ACP.md`
- Test: `src/acp/server.test.ts`(退出行字符串助手)

**Interfaces:**
- Produces: `export function shutdownNotice(signal: string): string`(返回 `[transcode] ${signal}: shutting down\n`);runAcpServer 的 SIGINT/SIGTERM 处理器先 stderr 该行再 exit。

- [ ] **Step 1: 写失败测试**:`shutdownNotice('SIGTERM')` 返回 `[transcode] SIGTERM: shutting down\n` → FAIL(未导出)
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**:两个 `process.once` 处理器补 `process.stderr.write(shutdownNotice(sig))`;ACP.md 方法表补 `agent/models` 行、`session/new` 校验说明、`error: ` 约定与 SIGTERM 行说明。
- [ ] **Step 4: 全量** `bun test` → 0 fail;`bun run typecheck`;`bun scripts/acp-smoke.ts` → passed
- [ ] **Step 5: 提交** `feat: SIGTERM shutdown notice; document host-facing conventions`
