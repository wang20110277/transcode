# 一步恢复会话(/resume 项目作用域选择器)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/resume` 无参数弹出当前项目的会话选择器(↑↓ + Enter + Esc),一条命令完成浏览+恢复。

**Architecture:** 纯逻辑(按 cwd 过滤列表、恢复目标解析)落到新模块 `src/sessions/resume.ts` 走 TDD;REPL 克隆现有 `model_select` 的 phase 状态机接键盘与渲染。带参 `/resume` 与 `/sessions` 行为不变。

**Tech Stack:** TypeScript + Ink(React)、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-21-one-step-resume-design.md`

## Global Constraints

- 选择器只列 `record.cwd === process.cwd()` 的会话(含旧平铺文件,按记录里的 `cwd` 字段命中);本项目为空时提示「当前项目暂无历史对话」,不回退全局
- 选择器最多 20 条,行格式沿用 `/sessions`:`N. 标题 · 时间 · 模型 · N 条`(spec 原文)
- `/resume <序号|id|标题片段>` 与 `/sessions`(全局列表+搜索)行为不变
- 键位:↑↓ 环形移动、Enter 恢复、Esc 走现有通用取消路径(同 `model_select`)
- 所有测试用 `TRANSCODE_SESSIONS_DIR` 指向 mkdtemp 临时目录,绝不触碰真实 `~/.transcode`

## Review Focus

- `/resume `(仅空白参数)必须等同于无参 → 弹选择器,而不是「未找到」(解析函数先 trim;Task 1 测试)
- 序号越界(`/resume 99`)→ 返回 undefined 走现有「未找到」提示,不崩溃(Task 1 测试)
- 旧平铺会话按记录内 `cwd` 字段命中本项目过滤(Task 1 测试)
- 精确 id 优先于片段匹配;id 与标题都能作为片段命中(Task 1 测试)
- 本项目零会话时 `/resume` 给提示而非空选择器(Task 2 接线,沿 Task 1 的空数组语义)

---

### Task 1: cwd 作用域列表 + 恢复目标解析(纯逻辑)

**Files:**
- Create: `src/sessions/resume.ts`
- Test: `src/sessions/resume.test.ts`

**Interfaces:**
- Consumes: `listSessions(): SessionRecord[]`(store.js,已按 updatedAt 倒序)、`SessionRecord`(store.js)
- Produces(Task 2 依赖,签名精确):
  - `listProjectSessions(cwd: string): SessionRecord[]` — 本项目会话,新→旧
  - `resolveResumeTarget(target: string, lastIds: string[], list: SessionRecord[]): SessionRecord | undefined`

- [ ] **Step 1: 写失败测试**(环境准备同 `store.test.ts`:`beforeEach` mkdtemp + 设 `TRANSCODE_SESSIONS_DIR`,`afterEach` 清理删除)

```ts
describe('listProjectSessions', () => {
  test('only returns sessions whose cwd matches, including legacy flat files', () => {
    saveSession({ ...sample('A', 'a'), id: 'ses_a', cwd: '/tmp/proj-a' });
    saveSession({ ...sample('B', 'b'), id: 'ses_b', cwd: '/tmp/proj-b' });
    // 旧平铺文件:直接 writeFileSync 到 sessions 根目录,记录内 cwd = '/tmp/proj-a'
    writeLegacyFlat('ses_legacy', '/tmp/proj-a');
    const ids = listProjectSessions('/tmp/proj-a').map(s => s.id).sort();
    expect(ids).toEqual(['ses_a', 'ses_legacy']);
  });
});

describe('resolveResumeTarget', () => {
  // list 顺序即 /sessions 展示顺序;lastIds 是上次列表的 id 快照
  test('numeric resolves through lastIds first, then falls back to list index', () => {
    expect(resolveResumeTarget('2', ['x1', 'ses_b'], list)?.id).toBe('ses_b');
    expect(resolveResumeTarget('1', [], list)?.id).toBe(list[0]!.id);
  });
  test('numeric out of range returns undefined', () => {
    expect(resolveResumeTarget('99', [], list)).toBeUndefined();
  });
  test('exact id beats substring; id/title substring both match', () => {
    expect(resolveResumeTarget('ses_a', [], list)?.id).toBe('ses_a');
    expect(resolveResumeTarget('proj', [], list)?.id).toBeDefined(); // 标题片段
  });
  test('blank target returns undefined (caller opens the picker)', () => {
    expect(resolveResumeTarget('   ', [], list)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/sessions/resume.test.ts`
Expected: FAIL — 模块 `./resume.js` 不存在(导出未找到)

- [ ] **Step 3: 实现 `src/sessions/resume.ts`**

- `listProjectSessions(cwd)` = `listSessions().filter(s => s.cwd === cwd)`(沿用既有排序)
- `resolveResumeTarget(target, lastIds, list)`:`target = target.trim()`,空 → undefined;`/^\d+$/` → `n = Number(target)`,先按 `lastIds[n-1]` 在 list 里找同 id 记录,否则 `list[n-1]`,越界 → undefined;否则 `list.find(r => r.id === target)` 优先,再 `find(r => r.id.includes(target) || r.title.includes(target))`
- 帮助函数(sample/writeLegacyFlat)只放测试文件

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/sessions/resume.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/sessions/resume.ts src/sessions/resume.test.ts
git commit -m "feat: cwd-scoped session list and pure resume-target resolution"
```

### Task 2: REPL 接线 session_select phase

**Files:**
- Modify: `src/screens/REPL.tsx` — phase 联合类型(~:48-60)、`modelCursor` 旁加状态(~:97)、`lastSessionsRef`(~:136)、`/resume` 分支(:628-657)、`useInput`(:717+ 的 `model_select` 分支旁)、`model_select` 渲染块后(:1029)、输入框门控(:1065)

**Interfaces:**
- Consumes: `listProjectSessions`、`resolveResumeTarget`(Task 1);`createToolSession`、`listSessions`、`getSession` 不变
- Produces: 无(终端交互)

- [ ] **Step 1: 状态与类型** — `PromptPhase` 增加 `'session_select'`;新增 `const [sessionCursor, setSessionCursor] = useState(0);` 与 `const sessionPickerRef = useRef<SessionRecord[]>([]);`;import Task 1 两个函数与 `SessionRecord` 类型

- [ ] **Step 2: 重写 `/resume` 分支** — 抽 `applyResume(record: SessionRecord)`(设 `conversationRef`/`conversationTitleRef`/`messagesRef`/`toolSessionRef` + `addHistory` 确认行,即现 :643-650 内容);无参路径:`listProjectSessions(process.cwd()).slice(0, 20)` 为空 → `addHistory`「当前项目暂无历史对话」,非空 → 写 `sessionPickerRef` + `lastSessionsRef.current = 快照 ids` + `setSessionCursor(0)` + `setPhase('session_select')` + `commitInput('')`;带参路径:内联解析替换为 `resolveResumeTarget(target, lastSessionsRef.current, listSessions())`,undefined → 现有「未找到」提示,命中 → `applyResume`

- [ ] **Step 3: `useInput` 新分支**(克隆 :761-820 的 `model_select` 分支)— `phase === 'session_select'`:`key.return` → `applyResume(sessionPickerRef.current[sessionCursor]!)` + `setPhase('idle')`;`key.upArrow`/`key.downArrow` → 环形移动 `% length`;Esc 由 :732-747 现有通用路径处理(处于 `phase !== 'idle'` 即回 idle),无需新增

- [ ] **Step 4: 渲染块**(插在 :1029 `model_select` 块后,镜像其结构)— 头行灰字「恢复对话 (↑↓ 选择 · Enter 恢复 · Esc 取消)」;每行 `❯ `/两空格 + `N. ${title} · ${new Date(updatedAt).toLocaleString()} · ${model} · ${messages.length} 条`,光标行 cyan;:1065 输入框门控改为 `phase !== 'model_select' && phase !== 'session_select'`

- [ ] **Step 5: 全量验证**

Run: `bun test`(全绿,含 Task 1 与既有 227 个)+ `npm run typecheck`(无输出)
另:`bun run dev` 手动冒烟 `/resume` ⏎ → 选择 → Esc(可选,交互无法自动化)

- [ ] **Step 6: Commit**

```bash
git add src/screens/REPL.tsx
git commit -m "feat: one-step /resume with cwd-scoped arrow-key session picker"
```
