# transcode 自动更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** REPL 启动时后台静默检查并安装 npm 更新（默认启用，24h 节流），`~/.transcode.json` 可关闭或钉住版本，`transcode upgrade [version]` 支持指定版本。

**Architecture:** 决策逻辑全部放两个纯函数（`normalizeAutoUpdate` 在 config.ts、`planAutoUpdate` 在 upgrade.ts），后台执行器 `startAutoUpdate` 是薄壳（读配置 → 纯函数决策 → npm 子进程），notice 经模块级 Promise 传入 REPL 展示横幅。现有 `runUpgrade` 拆出可复用的 `isDevInstall(entry, root)` 守卫。

**Tech Stack:** TypeScript + Bun（测试 `bun test`）、ink/React（REPL）、node:child_process（npm 子进程）。

**Spec:** `docs/superpowers/specs/2026-11-21-auto-update-design.md`

## Global Constraints

- 用户可见文案用中文，横幅格式固定：`⟳ 已自动更新 ${from} → ${to}，重启 transcode 生效`
- 注册表固定官方源 `https://registry.npmjs.org`（复用 upgrade.ts 的 `OFFICIAL` 常量，防镜像假升级）
- 不新增依赖；`tsc --noEmit` 必须保持零错误；现有 194 个测试保持全绿
- 环境变量：`TRANSCODE_SKIP_UPDATE=1` 强制关闭自动更新；`TRANSCODE_UPDATE_INTERVAL_HOURS` 覆盖节流时长（默认 24）
- `lastCheck` 仅在真正查询过 registry 后写回（失败不写，下次启动重试）
- 测试一律用 `TRANSCODE_CONFIG_PATH` 指向 mkdtemp 临时目录，绝不触碰真实 `~/.transcode.json`

## Review Focus

1. registry 不可达/超时 → 静默跳过且不写 `lastCheck` — Task 2 测 `unknown-latest`；Task 3 测 `disabled` 快速返回 null（网络路径靠 catch 兜底，Task 6 手动断网验证）
2. `autoUpdate` 为非法值（数字、字符串 `"yes"`、数组）→ 按默认启用处理，不抛错 — Task 1
3. 节流边界：距上次检查恰好 ≥ interval 才放行 — Task 2
4. 钉住版本 == 当前版本 → 不安装（含 `latest` == 当前）— Task 2
5. 仓库开发安装（bun link / checkout，entry 不在 npm root 下）→ 后台路径静默退出 — Task 3 对 `isDevInstall(entry, root)` 用 tmp 目录测两侧

---

### Task 1: `normalizeAutoUpdate` 配置规范化

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`（新建）

**Interfaces:**
- Produces:
```ts
export interface AutoUpdateConfig {
  enabled?: boolean;
  target?: string;      // 'latest'（缺省）或具体版本号
  lastCheck?: number;   // epoch ms
}
// TranscodeConfig 增加: autoUpdate?: boolean | AutoUpdateConfig
export interface NormalizedAutoUpdate { enabled: boolean; target: string; lastCheck: number }
export function normalizeAutoUpdate(raw: unknown): NormalizedAutoUpdate
```
规则：`false` → `{enabled:false, target:'latest', lastCheck:0}`；`undefined` → 默认启用；对象取字段（`enabled` 缺省 true，`target` 缺省 `'latest'`，`lastCheck` 缺省 0）；其余任何类型（数字/字符串/数组/null）→ 默认启用形。

- [ ] **Step 1: 写失败测试** — `src/config.test.ts`，`bun:test` 风格（参考 `src/screens/submit.test.ts`），describe `normalizeAutoUpdate`：false→关闭；undefined→enabled true；空对象→`{true,'latest',0}`；`{enabled:false,target:'0.3.0'}`→保留 target；`{enabled:true,target:'0.3.0',lastCheck:123}`→原样；非法值（`"yes"`、`5`、`null`、`[]`）→默认启用形
- [ ] **Step 2: 跑测确认失败** — `bun test src/config.test.ts` → Cannot find module 或 fail
- [ ] **Step 3: 实现** — config.ts 加类型 + `normalizeAutoUpdate`（纯函数，不碰 fs）
- [ ] **Step 4: 跑测通过** — `bun test src/config.test.ts` 全绿
- [ ] **Step 5: Commit** — `feat: normalizeAutoUpdate config parsing`

### Task 2: `planAutoUpdate` 决策纯函数

**Files:**
- Modify: `src/upgrade.ts`
- Test: `src/upgrade.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `NormalizedAutoUpdate`（仅形状）
- Produces:
```ts
export type AutoUpdatePlan =
  | { action: 'skip'; reason: 'env-skip' | 'disabled' | 'throttled' | 'up-to-date' | 'unknown-latest' }
  | { action: 'install'; spec: string; from: string; to: string };
export function planAutoUpdate(input: {
  current: string; latest: string | null; target: string;
  enabled: boolean; lastCheck: number; now: number;
  intervalHours?: number; envSkip?: boolean;
}): AutoUpdatePlan
```
顺序：envSkip→`env-skip`；!enabled→`disabled`；`now - lastCheck < (intervalHours ?? 24) * 3600_000`→`throttled`；target==='latest'：latest null→`unknown-latest`，===current→`up-to-date`，否则 install `@trans-ai/trans-code@latest`；具体 target：===current→`up-to-date`，否则 install `@trans-ai/trans-code@${target}`（允许降级）。`spec` 含包名全名。

- [ ] **Step 1: 写失败测试** — describe `planAutoUpdate`：env-skip 优先于一切；disabled；throttled（差 1ms 也拦）；边界 `now-lastCheck === interval` 放行；latest 模式 unknown-latest / up-to-date / install；pin 模式相同版本跳过、不同版本（含降级 0.4.0→0.3.0）install 且 spec 正确
- [ ] **Step 2: 跑测确认失败**
- [ ] **Step 3: 实现** — upgrade.ts 顶部导出纯函数
- [ ] **Step 4: 跑测通过**
- [ ] **Step 5: Commit** — `feat: planAutoUpdate decision function`

### Task 3: `isDevInstall` 守卫 + `startAutoUpdate` 后台执行

**Files:**
- Modify: `src/upgrade.ts`（从 `runUpgrade` 中抽出守卫）
- Test: `src/upgrade.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `normalizeAutoUpdate`、Task 2 `planAutoUpdate`
- Produces:
```ts
export function isDevInstall(entryPath: string, npmRoot: string): boolean  // 双参纯化，realpath 归一后前缀比较
export function autoUpdateNotice(): Promise<string | null>                 // 未启动时 resolve null
export function startAutoUpdate(): void                                    // 仅 REPL 路径调用；fire-and-forget
```
`startAutoUpdate` 内部：临时 `TRANSCODE_CONFIG_PATH` 读配置 → normalize → envSkip → dev-install（`isDevInstall(realpathSync(fileURLToPath(import.meta.url)), await npmRoot())`）→ `target !== 'latest'` 时 `latest = target`，否则 `latestVersion()` → `planAutoUpdate` → skip 则 notice=null；install 则 `npm i -g ${spec} --registry=OFFICIAL`，成功后 notice=`⟳ 已自动更新 ${current} → ${installed ?? to}，重启 transcode 生效` 并写回 lastCheck=now（skip 的 throttled/disabled 不写）；任何异常 catch → notice=null。`autoUpdateNotice()` 返回模块级已 settle/settling 的 promise（`startAutoUpdate` 未调用时为 `Promise.resolve(null)`）。
- [ ] **Step 1: 写失败测试** — `isDevInstall`：mkdtemp 建 `root/pkg/entry.js`（同侧 false）与 root 外文件（true）；`autoUpdateNotice`：未调用时 resolve null；`startAutoUpdate`（`TRANSCODE_CONFIG_PATH` 指临时配置写 `"autoUpdate": false`）→ notice 快速 resolve null 且不产生 npm 子进程（用 disabled 短路保证）
- [ ] **Step 2: 跑测确认失败**
- [ ] **Step 3: 实现** — 抽 `isDevInstall` 并让 `runUpgrade` 复用；实现 `startAutoUpdate`/`autoUpdateNotice`
- [ ] **Step 4: 跑测通过 + 全套回归** — `bun test`（194+新增）全绿
- [ ] **Step 5: Commit** — `feat: background auto-update with silent install`

### Task 4: `runUpgrade(target?)` 与 cli 子命令

**Files:**
- Modify: `src/upgrade.ts:61`（`runUpgrade` 签名加 `target?: string`）、`src/cli.ts:50-54`、`src/cli.ts` USAGE

**Interfaces:**
- Consumes: Task 3 `isDevInstall`
- Produces: `runUpgrade(target?: string): Promise<void>` — 有 target 时跳过 latest 比对直接装 `PKG@target`（仍走 dev-install 守卫与官方源），输出 `Upgrading ${VERSION} → ${target}…`
- [ ] **Step 1: 实现** — cli.ts：`const target = rest[0]; await runUpgrade(target)`；USAGE 第 8 行改为 `transcode upgrade [version]  Upgrade to the latest or a specific version`
- [ ] **Step 2: 验证** — `bun run typecheck` 零错误；`bun test` 全绿
- [ ] **Step 3: 手动冒烟** — `bun bin/transcode.ts --help` 输出含 `upgrade [version]`
- [ ] **Step 4: Commit** — `feat: upgrade to a specific version`

### Task 5: REPL 接入与更新横幅

**Files:**
- Modify: `src/cli.ts`（REPL 分支先 `startAutoUpdate()`）、`src/main.tsx:53`、`src/screens/REPL.tsx:51`（props）+ 新增 useEffect

**Interfaces:**
- Consumes: Task 3 `autoUpdateNotice`
- Produces: `REPLProps` 增加 `updateNotice?: Promise<string | null>`；App 传 `autoUpdateNotice()`
- [ ] **Step 1: 实现** — cli.ts REPL 分支（`await import('./main.js')` 前）调 `startAutoUpdate()`（acp/upgrade 分支不调）；main.tsx 传入；REPL 挂载时 `void updateNotice?.then(msg => { if (msg) { addHistory({input:'', output: msg}); dragFlush(); } })`，deps `[updateNotice]`
- [ ] **Step 2: 验证** — `bun run typecheck`；`bun test` 全绿
- [ ] **Step 3: Commit** — `feat: wire auto-update banner into the REPL`

### Task 6: E2E 验证与全局重装

**Files:** 无新改动（验证任务）

- [ ] **Step 1: 节流验证** — 临时配置 `lastCheck` = 当前时间 → `timeout 15 bun bin/transcode.ts` 启动退出，确认无 npm 安装输出、`lastCheck` 未变
- [ ] **Step 2: 钉版本验证** — 临时配置 `{"target":"0.3.0","lastCheck":0}`，`TRANSCODE_CONFIG_PATH=… timeout 60 bun bin/transcode.ts`，确认横幅与全局降至 0.3.0（`transcode --version`）；随后 `npm i -g .` 恢复开发版本
- [ ] **Step 3: 断网/强制关验证** — `TRANSCODE_SKIP_UPDATE=1` 启动无更新动作；配置 enabled:false 同样静默
- [ ] **Step 4: 全局重装收尾** — `npm i -g .`；`bun test` + `bun run typecheck` 最后确认
