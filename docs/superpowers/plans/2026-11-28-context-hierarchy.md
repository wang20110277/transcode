# 上下文文件层级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目说明文件从"只读工作区根一层"升级为:向上逐级查找(每级一个、越近优先)、`@路径` 导入、read_file 触发的子目录说明懒加载。

**Architecture:** 新建 `src/agent/context-files.ts` 承载全部层级机制(祖先链、每级择一、@导入、预算、子目录查找与会话去重);`system-prompt.ts` 的 `loadProjectContext` 改调它(REPL/ACP 两入口零改动);`tools/files.ts` 的 read_file 在返回前追加子目录说明。懒加载走工具结果,loop 与权限层不动。

**Tech Stack:** TypeScript(ESM)、bun:test、node:fs/node:path/node:child_process(git rev-parse)。

**Spec:** `docs/superpowers/specs/2026-11-28-context-hierarchy-design.md`

## Global Constraints

- 不新增依赖。
- 每级文件名优先级(逐字):`TRANS.md > AGENTS.md > CLAUDE.md > TRANSCODE.md > .transcode/AGENTS.md`;子目录列表不含 `.transcode/AGENTS.md`。
- 总预算 `40_000` 字符(沿用 `MAX_CONTEXT_CHARS`),最近一级优先分配;超限截断标注 `... (project instructions truncated)`。
- `@` 导入:仅整行 `@相对路径`;递归深度 ≤3;单文件 ≤64KB;缺失/超限/成环均以中文标注安全降级,不抛错。
- 无 git 时向上最多 5 级(含 cwd);有 git 时止于 git 根(含)。
- 测试用例名沿仓库惯例用中文;`bun test` 跑;TDD(先看失败)。
- 行为变化(spec 认可):根目录从"全部命中都载入"变为"每级只取一个"。

## Review Focus

1. 某级说明文件为空/纯空白 → 该级跳过,不出空小节(Task 1 测)。
2. cwd 即 git 根、其上一级也有 AGENTS.md → 仓库外那级不载入(Task 1 测)。
3. `@` 指向不存在路径/目录 → 标注降级不崩(Task 2 测)。
4. read_file 根目录文件(父目录===cwd)→ 不追加说明(已在系统提示)(Task 4 测)。
5. 同一子目录两次读文件 → 说明只注入一次;40K 多级截断时最近级保留(Task 1/4 测)。

---

### Task 1: 层级查找核心 `context-files.ts`

**Files:**
- Create: `src/agent/context-files.ts`
- Test: `src/agent/context-files.test.ts`
- Docs: 本计划与 spec 随本任务首次提交入库

**Interfaces:**
- Produces:
  - `export interface ContextFile { path: string; content: string }`(`path` 为相对 cwd 的展示路径,可为 `../AGENTS.md`)
  - `export async function gitRootOf(cwd: string): Promise<string | null>`(`git rev-parse --show-toplevel`,失败 null)
  - `export async function contextAncestors(cwd: string, gitRoot: string | null): Promise<string[]>`(最近→根,去重;null → cwd 起最多 5 级,止于文件系统根)
  - `export async function loadHierarchyContext(cwd: string, opts?: { gitRoot?: string | null; budget?: number }): Promise<ContextFile[]>`(`budget` 默认 `40_000`,测试可调小;未给 `gitRoot` 时内部调 `gitRootOf`;结果按**根→最近**排序;预算最近优先;本任务先不解析 `@` 导入)

- [ ] **Step 1: 写失败测试**

`src/agent/context-files.test.ts`,tmpdir 造层级(沿用 `system-prompt.test.ts` 的 mkdtemp+writeFileSync 惯例),用例:

- `多级目录:根→最近排序,每级只取一个`:`root/AGENTS.md`、`root/mid/CLAUDE.md`、`root/mid/leaf/TRANS.md`,cwd=leaf,`{gitRoot: root}` → 三条,顺序 `['../AGENTS.md', '../CLAUDE.md', 'TRANS.md']`。
- `每级按优先级取第一个命中`:同级放 `CLAUDE.md` 与 `TRANS.md` → 只载 `TRANS.md`。
- `预算最近优先`:预算传 120,最近级 100 字符 + 根级 100 字符 → 最近级全保留、根级截断且带 `(project instructions truncated)`。
- `git 根为界`:cwd=root(即 git 根),其上有 `AGENTS.md` → 只 1 条,不载仓库外。
- `无 git 最多 5 级`:6 级嵌套、`{gitRoot: null}` → 至多 5 条。
- `空文件视为未命中`:某级 `AGENTS.md` 仅空白 → 该级跳过。
- `gitRootOf`:tmpdir(非 git)→ null;本仓库根 → 返回绝对路径。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/agent/context-files.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `context-files.ts`**

`CONTEXT_FILE_NAMES` 常量 + 上述四函数。要点:每级择一用 `readOptional` 语义(`content.trim() || null`,空白即跳过);预算截断复用现有句式;`path.relative(cwd, absolute)` 做展示路径。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/agent/context-files.test.ts` → PASS

- [ ] **Step 5: 提交(含 spec 与 plan 文档)**

```bash
git add src/agent/context-files.ts src/agent/context-files.test.ts docs/superpowers/specs/2026-11-28-context-hierarchy-design.md docs/superpowers/plans/2026-11-28-context-hierarchy.md
git commit -m "feat: hierarchical context file discovery (walk-up, per-level pick)"
```

### Task 2: `@路径` 导入

**Files:**
- Modify: `src/agent/context-files.ts`
- Test: `src/agent/context-files.test.ts`

**Interfaces:**
- Produces: `export async function resolveContextImports(content: string, baseDir: string, depth?: number, seen?: Set<string>): Promise<string>`(默认 `depth=0, seen=new Set()`;展开后文本;`loadHierarchyContext` 在每级文件入选后调用它)
- Consumes: Task 1 的 `loadHierarchyContext`。

- [ ] **Step 1: 写失败测试**(追加用例)

- `整行 @ 展开`:文件含 `@docs/style.md` → 内容原位替换该行,路径相对**导入文件所在目录**。
- `深度 ≤3`:`@a`(内含 `@b`,再内 `@c`,c 内 `@d`)→ 第四层不展开,原行保留并标注。
- `单文件 64KB 截断`:导入 65KB 文件 → 保留 64KB + 截断标注。
- `循环导入`:a `@b`、b `@a` → 第二次出现标注跳过,不死循环。
- `缺失路径`:标注 `不存在` 类字样,不抛错。
- `行内 @ 不处理`:`详见 @foo.md 的说明` → 原样。
- `loadHierarchyContext 集成`:层级文件含 `@./extra.md` → 展开后进结果,且总预算约束生效。

- [ ] **Step 2: 跑测试确认失败** → FAIL(函数未导出)

- [ ] **Step 3: 实现**

逐行 `/^@(.+)$/` 匹配(trim 后);递归传 `depth+1` 与共享 `seen`(装绝对路径);标注统一中文:不存在 → `(@x 导入失败:文件不存在)`、超深 → `(@x 超过导入深度上限)`、截断 → 内容 + `... (@x 超过 64KB,已截断)`、成环 → `(@x 循环导入,已跳过)`。`loadHierarchyContext` 每级命中后先 `resolveContextImports` 再进预算。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `feat: @path imports in context files (depth/size/cycle bounded)`

### Task 3: 接线 `loadProjectContext`

**Files:**
- Modify: `src/agent/system-prompt.ts:89-108`(`loadProjectContext`)
- Test: `src/agent/system-prompt.test.ts`(改旧例 + 补新例)

**Interfaces:**
- Consumes: `loadHierarchyContext`。
- Produces: `loadProjectContext(cwd)` 签名不变(REPL/ACP 零改动);`CONTEXT_FILES` 常量删除或改为 re-export `CONTEXT_FILE_NAMES`。

- [ ] **Step 1: 改造测试**

- 旧例 `reads CLAUDE.md and AGENTS.md too, with TRANS.md taking priority`(:64)按行为变化改为:同级并存时**只载 TRANS.md**(spec 认可的行为变化)。
- 新例 `tmpdir 非 git 环境下载入 cwd 一层`:写 `TRANS.md` → projectFiles 含一条(tmpdir 无 git,自然走 5 级帽,祖先无干扰文件)。
- 其余旧例(`returns no project files…` 等)应保持通过。

- [ ] **Step 2: 跑测试确认失败**(旧行为还全载)

- [ ] **Step 3: 实现**

`loadProjectContext` 删平铺循环,改 `const projectFiles = await loadHierarchyContext(cwd);`,其余(gitBranch/userMemory)不动;`MAX_CONTEXT_CHARS` 移入 `context-files.ts` 或留原地引用。

- [ ] **Step 4: 跑测试确认通过** + 全量 `bun test src/agent/system-prompt.test.ts`

- [ ] **Step 5: 提交** `feat: loadProjectContext walks the hierarchy (one file per level)`

### Task 4: 子目录懒加载(read_file)

**Files:**
- Modify: `src/agent/tools/files.ts`(readFileTool.execute 返回前)
- Modify: `src/agent/context-files.ts`(新增子目录查找)
- Test: `src/agent/tools/files.test.ts`、`src/agent/context-files.test.ts`

**Interfaces:**
- Produces:
  - `export async function findSubdirContext(dir: string, cwd: string): Promise<ContextFile | null>`(`dir === cwd` 或已注入过 → null;候选名不含 `.transcode/AGENTS.md`;命中后登记)
  - `export function resetSubdirInjection(): void`(测试隔离用)
- Consumes: `resolveContextImports`(子目录说明同样展开 `@`)。

- [ ] **Step 1: 写失败测试**

context-files.test.ts:`findSubdirContext` 首次返回内容、同目录二次返回 null;`dir===cwd` → null;`resetSubdirInjection` 后可再次返回。
files.test.ts(沿用现有 ctx 惯例):tmpdir 下 `sub/AGENTS.md` + `sub/a.ts`,
- 读 `sub/a.ts` → output 尾部含 `[(来自 sub/AGENTS.md)]` 与说明内容;
- 再读 `sub/b.ts` → 不再追加;
- 读根目录 `README.md`(父目录===cwd)→ 不追加。

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**

`findSubdirContext` 内部模块级 `Set<string>` 存已注入绝对目录;read_file 在 `return truncate(...)` 前:`const dir = path.dirname(absolute); if (dir !== ctx.cwd) { const c = await findSubdirContext(dir, ctx.cwd); if (c) output += '\n\n' + `[(来自 ${c.path})]` + '\n' + c.content; }`(追加在截断之后,量小不参与截断)。图片/错误路径不追加。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `feat: read_file lazily injects subdirectory context notes`

### Task 5: 全量验证与收尾

**Files:**
- Modify: `docs/roadmap.md`(阶段一 #3 标"状态:已实现")

- [ ] **Step 1: 全量测试** `bun test` → 0 fail
- [ ] **Step 2: 类型检查** `bun run typecheck` → 干净
- [ ] **Step 3: roadmap 标记 #3 已实现;提交** `docs: mark roadmap item 3 (context hierarchy) done`
