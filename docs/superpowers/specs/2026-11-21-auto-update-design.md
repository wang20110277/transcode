# transcode 自动更新 — 设计

日期：2026-11-21 · 状态：待确认

## 意图

用户启动 transcode 时自动保持 npm 全局安装为最新（或配置指定的版本），无需手动 `transcode upgrade`。默认启用，可在 `~/.transcode.json` 关闭或钉住版本。

## 现有基础

`src/upgrade.ts` 已有手动 `transcode upgrade`：查 npm 官方源（防镜像假升级）、版本比对、`npm i -g` 安装、仓库开发安装识别。本设计将其拆出可复用的检查/安装原语。

## 行为设计（已确认：静默安装）

**触发**：仅 REPL 启动路径（`cli.ts` 进 REPL 前）；`acp` / `--version` / `help` / `upgrade` 子命令不触发。

**流程**：后台异步执行，绝不阻塞 REPL 启动——
1. 读取配置，未启用 → 退出（静默）
2. 节流：距上次检查 <24h → 退出（`TRANSCODE_UPDATE_INTERVAL_HOURS` 可调，`TRANSCODE_SKIP_UPDATE=1` 强制关闭）
3. 仓库开发安装（realpath 不在 npm root 下）→ 静默退出
4. 查目标版本：`target` 缺省 = `latest`；指定版本（如 `0.3.0`）= 钉住该版本（含降级）
5. 目标 ≠ 当前版本 → 静默 `npm i -g @trans-ai/trans-code@<target>`（官方源）
6. 完成/失败均不中断会话；成功后 REPL 内横幅一条：`⟳ 已自动更新 0.4.0 → 0.4.1，重启 transcode 生效`；失败静默（`TRANSCODE_DEBUG_UPGRADE=1` 可见原因）
7. 写回 `lastCheck` 时间戳

当前会话继续运行旧代码（新版本下次启动生效），避免运行中换文件。

## 配置（`~/.transcode.json`）

```json
{
  "autoUpdate": {
    "enabled": true,        // 缺省 true；"autoUpdate": false 为关闭简写
    "target": "latest",     // 或 "0.3.0" 钉住指定版本（含降级）
    "lastCheck": 0          // 内部节流缓存，epoch ms
  }
}
```

## 手动命令

`transcode upgrade [version]` — 带版本号参数时安装指定版本（一次性，不写 target），其余行为不变。

## 模块划分

- `config.ts`：`TranscodeConfig.autoUpdate?: boolean | { enabled?; target?; lastCheck? }` + `normalizeAutoUpdate()` 纯函数（false/对象/缺省 → 规范形）
- `upgrade.ts`：`planAutoUpdate()` 纯函数（输入 current/latest/config/now → 输出 skip 原因或 install spec）；`startAutoUpdate()` 后台执行并返回 notice Promise；`runUpgrade(target?)` 接受版本参数
- `cli.ts`：REPL 分支先 `startAutoUpdate()`，notice 以 Promise 传入 REPL，完成时 `addHistory` 横幅
- `main.tsx` / `REPL.tsx`：接受可选 notice prop，resolve 后展示

## 非目标

- 不做定时器/会话中周期检查（仅启动时）
- 不做更新日志/变更说明展示
- 不覆盖 `TRANSCODE_SKIP_UPDATE=1`

## 测试（TDD）

- `normalizeAutoUpdate`：false / 对象 / 缺省 / 非法值 → 规范形（enabled 默认 true）
- `planAutoUpdate`：未启用、节流中、已是目标版本、钉版本降级、升级、查不到版本 → 各自 action
- 现有 186+ 测试保持全绿
