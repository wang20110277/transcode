# 权限规则与「总是允许」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `~/.transcode.json` 里可配置 allow / ask / deny 三组规则；授权提示新增「本会话总是允许」（ACP 为 `allow_always`），同类调用在本会话内不再问；REPL 与 ACP 共用同一套判定。

**Architecture:** 规则的解析、匹配、判定、归纳全部收进一个纯函数模块 `src/agent/permission-rules.ts`（唯一的进程内状态是本会话记下的规则）。Agent 循环在每次工具调用时先过 `evaluatePermission`，只有结果是 `ask` 才调用 `requestPermission`；REPL 和 ACP 只负责"问人"，并把"总是"的回答记成会话规则。

**Tech Stack:** TypeScript + Bun test（已有，零新依赖）。

**Spec:** `docs/superpowers/specs/2026-11-25-permission-rules-design.md`

## Global Constraints

- **不提交**：按项目惯例，改动留在工作区，发版时再统一提交。每个任务以"跑测试 + typecheck"收尾，不执行 `git commit`。
- 判定顺序固定：模式（`readonly` / `plan` 拒绝变更）→ deny（配置或本会话）→ ask（配置）→ 不需要授权的调用 → allow（配置或本会话）→ `auto` 放行，否则询问。配置里的 deny 和 ask 优先于本会话的规则。
- 给模型的三段文字一字不改：
  - `PLAN_DENIAL`：`Plan mode is read-only: mutations are disabled. Finish exploring and output the numbered implementation plan (end with the line PLAN READY). The user will approve it before any changes are made.`
  - `READONLY_DENIAL`：`Readonly mode: mutations are disabled. Only read-only tools and commands are available.`
  - 规则拒绝：`Permission denied by rule "<规则>". Do not retry this call; choose another approach, or tell the user if it is required.`
- REPL 提示三行：`y  允许这一次` / `a  本会话总是允许  <规则>` / `n  拒绝`。`a` 行只在请求带有 `alwaysRule` 时出现。
- ACP 选项的 optionId 与 name：`allow_once` / `Allow once`、`allow_always` / `Always allow`、`reject_once` / `Reject`。
- bash 规则按词比较；结尾的 `*` 表示"以这些词开头"；没有 `*` 是整段原文相同（空白归一后）。allow 要求命令可安全解析且每一段都被放行；deny / ask 一段命中即算。
- 路径规则：不含 `/` 的模式按文件名匹配任意深度；含 `/` 的相对工作区根目录；`~/`、`/` 开头为绝对路径，`**/` 开头为任意深度；`*` 不跨目录，`**` 跨目录；`目录/**` 同时匹配目录本身；macOS 与 Windows 上不分大小写。
- 归纳规则、解释器清单、`exec` / `x` / `dlx` / `create` / `eval` 子命令清单，以设计文档「『总是允许』的归纳」一节为准，值写死在代码里。
- mock 模式（`TRANSCODE_MOCK=1`）里那一处直接调用 `requestPermission` 的写法不动。
- 文档只写中文，不提任何参考实现或对比。
- 测试隔离：凡是会读配置的测试，`TRANSCODE_CONFIG_PATH` 必须指向临时文件，并按 `src/plan-mode.test.ts` 里的 `ISOLATED_ENV` 清单清掉凭据环境变量、结束后恢复。会话规则是进程内状态，每个测试开始前调用 `clearSessionRules()`。
- 每个任务收尾：本任务的测试文件全绿；从任务 9 起另跑 `bun run typecheck`。

## File Structure

| 文件 | 职责 | 动作 |
| --- | --- | --- |
| `src/agent/tools/read-only.ts` | 导出 `parseSegments`，每一段带回原文 | 修改 |
| `src/agent/permission-rules.ts` | 规则解析、匹配、判定、归纳、会话规则、`/permissions` 的文本 | 新建 |
| `src/agent/permission-rules.test.ts` | 上面这个模块的单元测试 | 新建 |
| `src/config.ts` | `permissions` 配置的类型 | 修改 |
| `src/agent/loop.ts` | 每次工具调用先判定；`permissionMode` 选项；事件与请求的新字段 | 修改 |
| `src/agent/tools/types.ts` | `ToolContext` 透传 `permissionMode` 与 `alwaysRule` | 修改 |
| `src/agent/tools/index.ts` | 导出 `AGENT_TOOL_NAMES` | 修改 |
| `src/agent/tools/dispatch.ts` | 把 `permissionMode` 传给子 agent 的循环 | 修改 |
| `src/acp/permissions.ts` | ACP 选项与回答的映射（纯函数） | 新建 |
| `src/acp/permissions.test.ts` | 上面这个模块的单元测试 | 新建 |
| `src/acp/session.ts` | 三个选项、四种回答 | 修改 |
| `src/acp/server.ts` | `initialize` 时向 stderr 报告无效规则 | 修改 |
| `src/screens/REPL.tsx` | 三行提示、`a` 键、`(allowed: …)` 标记、启动提示、窗口预算 | 修改 |
| `src/commands.ts` | `/permissions` 命令 | 修改 |
| `src/agent/loop.test.ts` | 隔离配置文件 | 修改 |
| `src/permission-rules.integration.test.ts` | 循环、REPL、ACP 三处的行为（脚本化模型） | 新建 |
| `README.md`、`docs/ACP.md`、`docs/roadmap.md` | 文档同步 | 修改 |

---

### Task 1: `parseSegments` 带回每一段的原文

规则匹配要按原文比较带引号的命令，所以分段结果里要有每一段自己的文本。

**Files:**
- Modify: `src/agent/tools/read-only.ts`（`interface Segment` 与 `parseSegments`，约第 29–166 行）
- Test: `src/agent/tools/read-only.test.ts`

**Interfaces:**
- Produces: `export interface CommandSegment { tokens: string[]; raw: string }`；`export function parseSegments(command: string): { segments: CommandSegment[]; unsafe: boolean }`。`raw` 是该段的源文本：首尾空白去掉，连续空白压成一个空格。

- [ ] **Step 1: 写失败的测试**

`src/agent/tools/read-only.test.ts` 顶部的导入改成：

```ts
import { describe, expect, test } from 'bun:test';
import { isReadOnlyCommand, parseSegments } from './read-only.js';
```

文件末尾追加：

```ts
describe('parseSegments', () => {
  test('returns each segment with its own source text', () => {
    const { segments, unsafe } = parseSegments(
      'npm test  &&  FOO=1 git status | echo "a  b" ; ls # note\npwd',
    );

    expect(unsafe).toBe(false);
    expect(segments.map((segment) => segment.raw)).toEqual([
      'npm test',
      'FOO=1 git status',
      'echo "a b"',
      'ls',
      'pwd',
    ]);
    // Quoted text stays as written in the tokens; only `raw` collapses whitespace.
    expect(segments[2]!.tokens).toEqual(['echo', 'a  b']);
  });

  test('an empty command has no segments', () => {
    expect(parseSegments('   ')).toEqual({ segments: [], unsafe: false });
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/agent/tools/read-only.test.ts`
Expected: FAIL，报错里写明 `parseSegments` 没有被 `read-only.js` 导出。

- [ ] **Step 3: 实现**

把 `read-only.ts` 里的 `interface Segment {...}` 和整个 `parseSegments` 函数（含它上方的注释）替换成：

```ts
export interface CommandSegment {
  tokens: string[];
  /** The segment's source text: outer whitespace trimmed, runs of whitespace collapsed. */
  raw: string;
}

/**
 * Splits a command line into segments on unquoted separators, tracking
 * whether any unquoted disqualifying metacharacter appears. Backslash
 * escapes and single/double quotes are respected.
 */
export function parseSegments(command: string): { segments: CommandSegment[]; unsafe: boolean } {
  const segments: CommandSegment[] = [];
  let current: CommandSegment = { tokens: [], raw: '' };
  let token = '';
  let hasToken = false;
  let unsafe = false;
  // Where the current segment's source text starts: just past the last separator.
  let start = 0;

  const endToken = () => {
    if (hasToken) {
      current.tokens.push(token);
      token = '';
      hasToken = false;
    }
  };
  const endSegment = (end: number) => {
    endToken();
    if (current.tokens.length > 0) {
      segments.push({ ...current, raw: command.slice(start, end).replace(/\s+/g, ' ').trim() });
    }
    current = { tokens: [], raw: '' };
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (char === "'") {
      // Single quotes: everything literal until the closing quote.
      const close = command.indexOf("'", i + 1);
      if (close === -1) return { segments, unsafe: true }; // unterminated quote
      token += command.slice(i + 1, close);
      hasToken = true;
      i = close;
      continue;
    }

    if (char === '"') {
      const close = command.indexOf('"', i + 1);
      if (close === -1) return { segments, unsafe: true };
      for (let j = i + 1; j < close; j++) {
        if (command[j] === '\\' && j + 1 < close) {
          token += command[j + 1]!;
          j++;
        } else {
          token += command[j]!;
        }
      }
      hasToken = true;
      i = close;
      continue;
    }

    if (char === '\\') {
      if (i + 1 >= command.length) return { segments, unsafe: true };
      token += command[i + 1]!;
      hasToken = true;
      i++;
      continue;
    }

    if (char === ';' || char === '\n') {
      endSegment(i);
      start = i + 1;
      continue;
    }

    if (char === '|' || char === '&') {
      const first = i;
      if (command[i + 1] === char) i++; // || or &&
      endSegment(first);
      start = i + 1;
      continue;
    }

    if (char === '>') {
      // Output redirection: harmless when the target is /dev/null or an fd
      // duplication (2>&1); anything else writes a file and disqualifies.
      let j = i + 1;
      if (command[j] === '>') j++; // >>
      let k = j;
      while (k < command.length && /\s/.test(command[k]!)) k++;
      if (command[k] === '&' && /[0-9]/.test(command[k + 1] ?? '')) {
        i = k + 1; // >&N — safe, consumed
        continue;
      }
      let t = k;
      if (command[t] === '"' || command[t] === "'") t++;
      if (command.startsWith('/dev/null', t)) {
        i = t + 8; // >/dev/null — safe, consumed
        continue;
      }
      unsafe = true;
      continue;
    }

    if (char === '<') {
      // Heredocs (<<) and process substitution (<() are disqualifying;
      // a plain input redirect (< file) only reads.
      if (command[i + 1] === '<' || command[i + 1] === '(' || command[i + 1] === '>') {
        unsafe = true;
        continue;
      }
      continue; // target tokenizes as a regular word
    }

    if (char === '`') {
      unsafe = true; // backtick substitution
      continue;
    }

    if (char === '$' && command[i + 1] === '(') {
      unsafe = true; // command substitution
      continue;
    }

    if (char === '#' && !hasToken) {
      // Comment: the segment ends here; the rest of the line is ignored.
      endSegment(i);
      const nl = command.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }

    if (/\s/.test(char)) {
      endToken();
      continue;
    }

    token += char;
    hasToken = true;
  }
  endSegment(command.length);

  return { segments, unsafe };
}
```

`isReadOnlyCommand` 不用改：它只读 `segment.tokens`。

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/agent/tools/read-only.test.ts`
Expected: PASS，原有的只读识别用例全部保持通过。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 2: 规则解析

**Files:**
- Create: `src/agent/permission-rules.ts`
- Create: `src/agent/permission-rules.test.ts`
- Modify: `src/config.ts`（`TranscodeConfig`，约第 15–30 行）

**Interfaces:**
- Produces:
  - `type RuleEffect = 'allow' | 'ask' | 'deny'`，`type RuleSource = 'config' | 'session'`
  - `interface PermissionRule { effect: RuleEffect; tool: string; pattern?: string; source: RuleSource; text: string }`
  - `interface InvalidRule { effect: RuleEffect; raw: string; reason: string }`
  - `interface PermissionRuleSet { rules: PermissionRule[]; invalid: InvalidRule[] }`
  - `const PATH_TOOLS: readonly string[]`
  - `function parsePermissionRules(config: unknown, toolNames: readonly string[]): PermissionRuleSet`
  - `function loadPermissionRules(toolNames: readonly string[]): PermissionRuleSet`
  - `function ruleText(tool: string, pattern?: string): string`

- [ ] **Step 1: 写失败的测试**

新建 `src/agent/permission-rules.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PATH_TOOLS,
  loadPermissionRules,
  parsePermissionRules,
} from './permission-rules.js';

/** Every registered tool, as the loop and the commands see them. */
const TOOLS = [
  'bash', 'bash_output', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'todo_write',
  'ask_model', 'dispatch_agent', 'memory_save', 'memory_delete', 'web_fetch', 'web_search',
];

describe('parsePermissionRules', () => {
  test('a rule is a tool name, or a tool name with an object in parentheses', () => {
    const { rules, invalid } = parsePermissionRules(
      {
        permissions: {
          allow: ['bash(npm test*)', 'web_fetch'],
          ask: ['bash(git push*)'],
          deny: ['read_file(**/.env*)'],
        },
      },
      TOOLS,
    );

    expect(invalid).toEqual([]);
    expect(rules.map((rule) => [rule.effect, rule.text, rule.pattern, rule.source])).toEqual([
      ['allow', 'bash(npm test*)', 'npm test*', 'config'],
      ['allow', 'web_fetch', undefined, 'config'],
      ['ask', 'bash(git push*)', 'git push*', 'config'],
      ['deny', 'read_file(**/.env*)', '**/.env*', 'config'],
    ]);
  });

  test('an object may itself contain parentheses', () => {
    const { rules, invalid } = parsePermissionRules(
      { permissions: { allow: ['bash(echo (hi))'] } },
      TOOLS,
    );

    expect(invalid).toEqual([]);
    expect(rules[0]!.pattern).toBe('echo (hi)');
  });

  test('miswritten rules are reported with a reason and left out', () => {
    const { rules, invalid } = parsePermissionRules(
      {
        permissions: {
          allow: ['bash(npm test', 'no_such_tool', 'web_search(x)', 'bash()', '', 42],
          deny: ['(x)'],
        },
      },
      TOOLS,
    );

    expect(rules).toEqual([]);
    expect(invalid.map((item) => [item.effect, item.raw, item.reason])).toEqual([
      ['allow', 'bash(npm test', "missing ')'"],
      ['allow', 'no_such_tool', 'unknown tool: no_such_tool'],
      ['allow', 'web_search(x)', 'web_search takes no pattern; write just "web_search"'],
      ['allow', 'bash()', 'empty pattern'],
      ['allow', '', 'empty rule'],
      ['allow', '42', 'a rule must be a string'],
      ['deny', '(x)', 'empty rule'],
    ]);
  });

  test('no permissions section means no rules and no complaints', () => {
    expect(parsePermissionRules({}, TOOLS)).toEqual({ rules: [], invalid: [] });
    expect(parsePermissionRules({ permissions: 'allow everything' }, TOOLS)).toEqual({
      rules: [],
      invalid: [],
    });
    expect(parsePermissionRules(null, TOOLS)).toEqual({ rules: [], invalid: [] });
  });

  test('the path tools are the ones whose object is a file path', () => {
    expect([...PATH_TOOLS]).toEqual(['read_file', 'write_file', 'edit_file', 'glob', 'grep']);
  });
});

describe('loadPermissionRules', () => {
  let dir: string;
  const savedPath = process.env.TRANSCODE_CONFIG_PATH;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'transcode-rule-config-'));
    process.env.TRANSCODE_CONFIG_PATH = path.join(dir, 'config.json');
    writeFileSync(process.env.TRANSCODE_CONFIG_PATH, '{}');
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.TRANSCODE_CONFIG_PATH;
    else process.env.TRANSCODE_CONFIG_PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads the rules from the config file every time it is called', () => {
    expect(loadPermissionRules(TOOLS).rules).toEqual([]);

    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ permissions: { allow: ['bash(ls)'], deny: ['bash('] } }),
    );

    const loaded = loadPermissionRules(TOOLS);
    expect(loaded.rules.map((rule) => rule.text)).toEqual(['bash(ls)']);
    expect(loaded.invalid.map((item) => item.reason)).toEqual(["missing ')'"]);
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: FAIL，报找不到模块 `./permission-rules.js`。

- [ ] **Step 3: 实现**

新建 `src/agent/permission-rules.ts`：

```ts
/**
 * Permission rules: the `permissions` section of ~/.transcode.json plus the
 * rules a session remembers from "always allow". Everything here is a pure
 * function of its arguments; the only state is the list of session rules.
 */
import { loadConfig } from '../config.js';

export type RuleEffect = 'allow' | 'ask' | 'deny';
export type RuleSource = 'config' | 'session';

export interface PermissionRule {
  effect: RuleEffect;
  /** Tool the rule constrains. */
  tool: string;
  /** Text between the parentheses; absent for a whole-tool rule. */
  pattern?: string;
  source: RuleSource;
  /** Canonical text as written and shown, e.g. `bash(npm test*)`. */
  text: string;
}

export interface InvalidRule {
  effect: RuleEffect;
  raw: string;
  reason: string;
}

export interface PermissionRuleSet {
  rules: PermissionRule[];
  invalid: InvalidRule[];
}

/** Tools whose pattern is a file path. */
export const PATH_TOOLS: readonly string[] = ['read_file', 'write_file', 'edit_file', 'glob', 'grep'];
/** Constrained only as a whole: a pattern on one of these is a mistake. */
const NAME_ONLY_TOOLS: readonly string[] = ['web_search', 'todo_write', 'bash_output'];
const EFFECTS: readonly RuleEffect[] = ['allow', 'ask', 'deny'];

function ruleText(tool: string, pattern?: string): string {
  return pattern === undefined ? tool : `${tool}(${pattern})`;
}

/**
 * Parses one rule. The object runs from the first `(` to the last `)`, so it
 * may itself contain parentheses.
 */
function parseOne(effect: RuleEffect, entry: string, toolNames: readonly string[]): PermissionRule | InvalidRule {
  const raw = entry.trim();
  const open = raw.indexOf('(');
  const tool = (open === -1 ? raw : raw.slice(0, open)).trim();
  const reject = (reason: string): InvalidRule => ({ effect, raw, reason });

  if (!tool || !toolNames.includes(tool)) {
    return reject(tool ? `unknown tool: ${tool}` : 'empty rule');
  }
  if (open === -1) return { effect, tool, source: 'config', text: ruleText(tool) };
  if (!raw.endsWith(')')) return reject("missing ')'");
  const pattern = raw.slice(open + 1, -1).trim();
  if (NAME_ONLY_TOOLS.includes(tool)) {
    return reject(`${tool} takes no pattern; write just "${tool}"`);
  }
  if (!pattern) return reject('empty pattern');
  return { effect, tool, pattern, source: 'config', text: ruleText(tool, pattern) };
}

export function parsePermissionRules(config: unknown, toolNames: readonly string[]): PermissionRuleSet {
  const section = (config as { permissions?: unknown } | null | undefined)?.permissions;
  if (!section || typeof section !== 'object') return { rules: [], invalid: [] };

  const rules: PermissionRule[] = [];
  const invalid: InvalidRule[] = [];
  for (const effect of EFFECTS) {
    const list = (section as Record<string, unknown>)[effect];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'string') {
        invalid.push({ effect, raw: String(entry), reason: 'a rule must be a string' });
        continue;
      }
      const parsed = parseOne(effect, entry, toolNames);
      if ('reason' in parsed) invalid.push(parsed);
      else rules.push(parsed);
    }
  }
  return { rules, invalid };
}

/** The rules configured right now. Read on every decision, so an edit applies to the next tool call. */
export function loadPermissionRules(toolNames: readonly string[]): PermissionRuleSet {
  return parsePermissionRules(loadConfig(), toolNames);
}
```

`src/config.ts` 的 `TranscodeConfig` 里，在 `webSearch?: unknown;` 之后加一行：

```ts
  /** Permission rules by effect; each entry is `tool` or `tool(object)`. See agent/permission-rules.ts. */
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: PASS，6 个用例。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 3: 命令规则的匹配

**Files:**
- Modify: `src/agent/permission-rules.ts`
- Test: `src/agent/permission-rules.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseSegments` / `CommandSegment`；Task 2 的 `PermissionRule`。
- Produces:
  - `interface PermissionCall { name: string; input: Record<string, unknown>; cwd: string; shellCwd?: string }`
  - `function commandAllowed(command: string, rules: readonly PermissionRule[]): PermissionRule | undefined`（放行这条命令的第一条 allow 规则；没有则 `undefined`）
  - `function ruleMatches(rule: PermissionRule, call: PermissionCall): boolean`（本任务只对 `bash` 有意义，其它工具返回 `false`）

- [ ] **Step 1: 写失败的测试**

`permission-rules.test.ts` 的导入改成：

```ts
import {
  PATH_TOOLS,
  commandAllowed,
  loadPermissionRules,
  parsePermissionRules,
  ruleMatches,
  type PermissionCall,
  type PermissionRule,
  type RuleEffect,
} from './permission-rules.js';
```

在 `const TOOLS = [...]` 之后加两个小工具，文件末尾追加一组用例：

```ts
/** Parses one rule, failing the test if it does not parse. */
const rule = (text: string, effect: RuleEffect = 'allow'): PermissionRule => {
  const parsed = parsePermissionRules({ permissions: { [effect]: [text] } }, TOOLS);
  expect(parsed.invalid).toEqual([]);
  return parsed.rules[0]!;
};
const bashCall = (command: string): PermissionCall => ({ name: 'bash', input: { command }, cwd: '/work' });
```

```ts
describe('command rules', () => {
  test('a trailing * means "starts with these words"', () => {
    const allowed = rule('bash(npm test*)');
    expect(ruleMatches(allowed, bashCall('npm test'))).toBe(true);
    expect(ruleMatches(allowed, bashCall('npm test -- --watch'))).toBe(true);
    expect(ruleMatches(allowed, bashCall('npm tests'))).toBe(false);
    expect(ruleMatches(allowed, bashCall('npm run test'))).toBe(false);
  });

  test('the * may stand alone or stick to the last word, and means the same', () => {
    for (const text of ['bash(rm -rf *)', 'bash(rm -rf*)']) {
      const denied = rule(text, 'deny');
      expect(ruleMatches(denied, bashCall('rm -rf build'))).toBe(true);
      expect(ruleMatches(denied, bashCall('rm -r build'))).toBe(false);
    }
  });

  test('without a * the segment must be identical, give or take whitespace', () => {
    const exact = rule('bash(npm  test)');
    expect(ruleMatches(exact, bashCall('npm test'))).toBe(true);
    expect(ruleMatches(exact, bashCall('npm test -- --watch'))).toBe(false);

    const quoted = rule('bash(sh -c "rm -rf build")');
    expect(ruleMatches(quoted, bashCall('  sh -c "rm -rf  build"  '))).toBe(true);
  });

  test('leading VAR=value assignments are ignored when comparing words', () => {
    expect(ruleMatches(rule('bash(npm test*)'), bashCall('CI=1 npm test'))).toBe(true);
  });

  test('a bare bash rule matches every command', () => {
    expect(ruleMatches(rule('bash'), bashCall('anything --at all'))).toBe(true);
  });

  test('deny and ask rules hit when any one segment matches', () => {
    const denied = rule('bash(rm -rf *)', 'deny');
    expect(ruleMatches(denied, bashCall('npm test && rm -rf build'))).toBe(true);
    expect(ruleMatches(denied, bashCall('ls | grep x'))).toBe(false);
  });

  test('allow needs every segment allowed, on a command that is safe to parse', () => {
    const rules = [rule('bash(git status*)'), rule('bash(npm test*)')];
    expect(commandAllowed('git status --short && npm test', rules)?.text).toBe('bash(git status*)');
    expect(commandAllowed('git status --short && npm run build', rules)).toBeUndefined();
    expect(commandAllowed('npm test && rm -rf build', rules)).toBeUndefined();
    // A substitution or an output redirection can hide anything.
    expect(commandAllowed('npm test $(rm -rf build)', rules)).toBeUndefined();
    expect(commandAllowed('npm test > ~/.bashrc', rules)).toBeUndefined();
    // A bare bash rule allows the whole command.
    expect(commandAllowed('npm test && rm -rf build', [rule('bash')])?.text).toBe('bash');
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: FAIL，`commandAllowed` / `ruleMatches` 不是函数。

- [ ] **Step 3: 实现**

`permission-rules.ts` 顶部的导入改成：

```ts
import { parseSegments, type CommandSegment } from './tools/read-only.js';
import { loadConfig } from '../config.js';
```

在 `loadPermissionRules` 之后追加：

```ts
/** One tool call as the rules see it. */
export interface PermissionCall {
  name: string;
  input: Record<string, unknown>;
  /** Workspace root: path patterns are relative to it. */
  cwd: string;
  /** The shell's current directory (`cd` persists between calls); defaults to cwd. */
  shellCwd?: string;
}

interface CommandPattern {
  /** Words the command must start with; empty means "any". */
  words: string[];
  /** A trailing `*`, alone or stuck to the last word. */
  wildcard: boolean;
}

function parseCommandPattern(pattern: string): CommandPattern {
  const trimmed = pattern.trim();
  const wildcard = trimmed.endsWith('*');
  const body = (wildcard ? trimmed.slice(0, -1) : trimmed).trim();
  return { words: body === '' ? [] : body.split(/\s+/), wildcard };
}

/** Drops leading `VAR=value` assignments, as the read-only check does. */
function stripAssignments(tokens: string[]): string[] {
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start++;
  return tokens.slice(start);
}

function segmentMatches(segment: CommandSegment, spec: CommandPattern): boolean {
  if (!spec.wildcard) return segment.raw === spec.words.join(' ');
  const words = stripAssignments(segment.tokens);
  if (words.length < spec.words.length) return false;
  return spec.words.every((word, index) => words[index] === word);
}

/** A bash rule hits when any one segment of the command matches. */
function bashRuleMatches(pattern: string, command: string): boolean {
  const spec = parseCommandPattern(pattern);
  return parseSegments(command).segments.some((segment) => segmentMatches(segment, spec));
}

/**
 * The allow rule that spares the prompt for this command, if any. Every
 * segment must be allowed, and the command must be safe to parse: a
 * substitution or an output redirection can hide anything.
 */
export function commandAllowed(command: string, rules: readonly PermissionRule[]): PermissionRule | undefined {
  const { segments, unsafe } = parseSegments(command);
  if (unsafe || segments.length === 0) return undefined;

  const whole = rules.find((rule) => rule.pattern === undefined);
  if (whole) return whole;

  const specs = rules.flatMap((rule) =>
    rule.pattern === undefined ? [] : [{ rule, spec: parseCommandPattern(rule.pattern) }],
  );
  let first: PermissionRule | undefined;
  for (const segment of segments) {
    const hit = specs.find(({ spec }) => segmentMatches(segment, spec));
    if (!hit) return undefined;
    if (first === undefined) first = hit.rule;
  }
  return first;
}

/** Whether one rule covers one call. */
export function ruleMatches(rule: PermissionRule, call: PermissionCall): boolean {
  if (rule.tool !== call.name) return false;
  if (rule.tool === 'bash') {
    return rule.pattern === undefined || bashRuleMatches(rule.pattern, String(call.input.command ?? ''));
  }
  return false; // Path tools: Task 4. Other tools: Task 5.
}
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 4: 路径规则的匹配，以及 bash 命令里被拒绝的路径

**Files:**
- Modify: `src/agent/permission-rules.ts`
- Test: `src/agent/permission-rules.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `PermissionCall`、`ruleMatches`、`stripAssignments`。
- Produces:
  - `function pathMatches(pattern: string, target: string, cwd: string): boolean`
  - `function deniedPathInCommand(command: string, denyRules: readonly PermissionRule[], call: PermissionCall): PermissionRule | undefined`
  - `ruleMatches` 对 `PATH_TOOLS` 生效。

- [ ] **Step 1: 写失败的测试**

测试文件的导入里加上 `deniedPathInCommand`、`pathMatches`，并在最上面加一行：

```ts
import { homedir } from 'node:os';
```

文件末尾追加：

```ts
const fileCall = (name: string, target: string): PermissionCall => ({ name, input: { path: target }, cwd: '/work' });

describe('path rules', () => {
  test('a pattern without a slash matches the file name at any depth', () => {
    const denied = rule('read_file(.env*)', 'deny');
    expect(ruleMatches(denied, fileCall('read_file', '.env'))).toBe(true);
    expect(ruleMatches(denied, fileCall('read_file', 'config/.env.local'))).toBe(true);
    expect(ruleMatches(denied, fileCall('read_file', 'src/env.ts'))).toBe(false);
  });

  test('a pattern with a slash is anchored at the workspace root', () => {
    const denied = rule('edit_file(.transcode/**)', 'deny');
    expect(ruleMatches(denied, fileCall('edit_file', '.transcode/settings.json'))).toBe(true);
    expect(ruleMatches(denied, fileCall('edit_file', 'src/.transcode/x.json'))).toBe(false);
  });

  test('* stays inside one directory, ** crosses them, and dir/** covers the directory itself', () => {
    const one = rule('read_file(src/*.ts)', 'deny');
    expect(ruleMatches(one, fileCall('read_file', 'src/a.ts'))).toBe(true);
    expect(ruleMatches(one, fileCall('read_file', 'src/agent/a.ts'))).toBe(false);

    const deep = rule('read_file(src/**/a.ts)', 'deny');
    expect(ruleMatches(deep, fileCall('read_file', 'src/a.ts'))).toBe(true);
    expect(ruleMatches(deep, fileCall('read_file', 'src/agent/tools/a.ts'))).toBe(true);

    const whole = rule('grep(secrets/**)', 'deny');
    expect(ruleMatches(whole, fileCall('grep', 'secrets'))).toBe(true);
    expect(ruleMatches(whole, fileCall('grep', 'secrets/prod/key.pem'))).toBe(true);
  });

  test('~/ and / mean absolute, **/ means any depth', () => {
    const home = rule('read_file(~/.ssh/**)', 'deny');
    expect(ruleMatches(home, fileCall('read_file', `${homedir()}/.ssh/id_rsa`))).toBe(true);
    expect(ruleMatches(home, fileCall('read_file', '.ssh/id_rsa'))).toBe(false);

    const any = rule('read_file(**/.env*)', 'deny');
    expect(ruleMatches(any, fileCall('read_file', '.env'))).toBe(true);
    expect(ruleMatches(any, fileCall('read_file', 'a/b/.env.production'))).toBe(true);

    expect(pathMatches('/etc/**', '/etc/hosts', '/work')).toBe(true);
    expect(pathMatches('/etc/**', '/work/etc/hosts', '/work')).toBe(false);
  });

  test('case matters only on file systems that distinguish it', () => {
    const folds = process.platform === 'darwin' || process.platform === 'win32';
    expect(pathMatches('README.md', 'readme.md', '/work')).toBe(folds);
    expect(pathMatches('src/*.ts', 'SRC/a.ts', '/work')).toBe(folds);
  });

  test('.. and ./ in the target are resolved before matching', () => {
    const denied = rule('read_file(config/**)', 'deny');
    expect(ruleMatches(denied, fileCall('read_file', './src/../config/x.yml'))).toBe(true);
  });

  test('a bare path-tool rule matches every call of that tool', () => {
    expect(ruleMatches(rule('grep', 'deny'), fileCall('grep', 'anything'))).toBe(true);
  });

  test('grep without a path takes no part in path matching; glob falls back to its pattern', () => {
    const denied = rule('grep(**/.env*)', 'deny');
    const bare: PermissionCall = { name: 'grep', input: { pattern: 'API_KEY' }, cwd: '/work' };
    expect(ruleMatches(denied, bare)).toBe(false);
    expect(ruleMatches(denied, { ...bare, input: { pattern: 'API_KEY', path: 'config/.env' } })).toBe(true);

    const byName = rule('glob(.env*)', 'deny');
    const listing: PermissionCall = { name: 'glob', input: { pattern: '**/.env*' }, cwd: '/work' };
    expect(ruleMatches(byName, listing)).toBe(true);
  });
});

describe('denied paths inside bash commands', () => {
  const denyEnv = () => [rule('read_file(.env*)', 'deny')];

  test('a literal path argument under a denied path is refused, whatever file tool the rule names', () => {
    const hit = 'read_file(.env*)';
    expect(deniedPathInCommand('cat .env', denyEnv(), bashCall('cat .env'))?.text).toBe(hit);
    expect(deniedPathInCommand('grep -n KEY config/.env', denyEnv(), bashCall('grep -n KEY config/.env'))?.text).toBe(hit);
    // Parentheses around the argument are trimmed.
    expect(deniedPathInCommand('echo "(.env)"', denyEnv(), bashCall('echo "(.env)"'))?.text).toBe(hit);
  });

  test('flags are skipped and unrelated arguments pass', () => {
    expect(deniedPathInCommand('git commit -m update', denyEnv(), bashCall('git commit -m update'))).toBeUndefined();
    expect(deniedPathInCommand('cat README.md', denyEnv(), bashCall('cat README.md'))).toBeUndefined();
  });

  test('a path argument is resolved against the shell directory, not the workspace root', () => {
    const call: PermissionCall = {
      name: 'bash',
      input: { command: 'cat ../../secrets/key.pem' },
      cwd: '/work',
      shellCwd: '/work/src/agent',
    };
    const denies = [rule('edit_file(secrets/**)', 'deny')];
    expect(deniedPathInCommand('cat ../../secrets/key.pem', denies, call)?.text).toBe('edit_file(secrets/**)');
  });

  test('whole-tool denies do not apply to bash arguments', () => {
    expect(deniedPathInCommand('cat .env', [rule('read_file', 'deny')], bashCall('cat .env'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: FAIL，`deniedPathInCommand` / `pathMatches` 不是函数，路径规则的用例失败。

- [ ] **Step 3: 实现**

`permission-rules.ts` 顶部加上导入：

```ts
import { homedir } from 'node:os';
import path from 'node:path';
```

在 `bashRuleMatches` 之后、`commandAllowed` 之前插入：

```ts
/** macOS and Windows file systems do not distinguish case; neither do path rules there. */
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

/** One path segment as a regex source: `*` stays inside the segment, everything else is literal. */
function globSource(part: string): string {
  let source = '';
  for (const char of part) {
    if (char === '*') source += '[^/]*';
    else source += /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return source;
}

const toPosix = (value: string): string => value.split(path.sep).join('/');

/** A whole pattern as an anchored regex. A `**` segment spans directories; a trailing `dir/**` also covers `dir` itself. */
function pathRegex(pattern: string): RegExp {
  const parts = pattern.split('/');
  let source = '';
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === '**' && last) {
      // `dir/**` must also match `dir`: the slash before `**` becomes optional.
      source = source.endsWith('/') ? `${source.slice(0, -1)}(?:/.*)?` : '.*';
      return;
    }
    if (part === '**') {
      source += '(?:[^/]+/)*'; // a leading or middle `**/`: any number of directories
      return;
    }
    source += globSource(part);
    if (!last) source += '/';
  });
  return new RegExp(`^${source}$`, FOLD_CASE ? 'i' : '');
}

/**
 * Whether a path rule covers `target`. A pattern without a slash matches
 * the file name at any depth. With a slash it is relative to the workspace
 * root, unless it is absolute or starts with `~/`.
 */
export function pathMatches(pattern: string, target: string, cwd: string): boolean {
  const expanded = pattern.replace(/^~(?=\/|$)/, homedir());
  const absolute = toPosix(path.resolve(cwd, target));
  const flags = FOLD_CASE ? 'i' : '';

  if (path.isAbsolute(expanded)) return pathRegex(toPosix(expanded)).test(absolute);

  const posix = toPosix(expanded);
  if (!posix.includes('/')) {
    return new RegExp(`^${globSource(posix)}$`, flags).test(absolute.slice(absolute.lastIndexOf('/') + 1));
  }
  return pathRegex(posix).test(toPosix(path.relative(cwd, path.resolve(cwd, target))));
}

/** The path a path-tool call works on: `path`, or for glob its pattern when no directory is given. */
function pathTarget(name: string, input: Record<string, unknown>): string | undefined {
  const value = input.path ?? (name === 'glob' ? input.pattern : undefined);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Deny rules with a path also cover bash: a read-only `cat .env` would
 * otherwise walk around a rule against reading `.env`. Every non-flag
 * argument is taken as a path and resolved against the shell's directory.
 * Best effort only: expanded variables and files a program opens itself are invisible here.
 */
export function deniedPathInCommand(
  command: string,
  denyRules: readonly PermissionRule[],
  call: PermissionCall,
): PermissionRule | undefined {
  const pathDenies = denyRules.filter((rule) => PATH_TOOLS.includes(rule.tool) && rule.pattern !== undefined);
  if (pathDenies.length === 0) return undefined;

  const base = call.shellCwd ?? call.cwd;
  for (const segment of parseSegments(command).segments) {
    const words = stripAssignments(segment.tokens);
    for (const argument of words.slice(1)) {
      if (argument.startsWith('-')) continue;
      const cleaned = argument.replace(/^\(+|\)+$/g, '');
      if (!cleaned) continue;
      const target = path.resolve(base, cleaned);
      const hit = pathDenies.find((rule) => pathMatches(rule.pattern!, target, call.cwd));
      if (hit) return hit;
    }
  }
  return undefined;
}
```

把 `ruleMatches` 换成下面这版（比任务 3 多了路径工具一段）：

```ts
/** Whether one rule covers one call. */
export function ruleMatches(rule: PermissionRule, call: PermissionCall): boolean {
  if (rule.tool !== call.name) return false;
  if (rule.tool === 'bash') {
    return rule.pattern === undefined || bashRuleMatches(rule.pattern, String(call.input.command ?? ''));
  }
  if (PATH_TOOLS.includes(rule.tool)) {
    const target = pathTarget(rule.tool, call.input);
    return target !== undefined && (rule.pattern === undefined || pathMatches(rule.pattern, target, call.cwd));
  }
  return false; // Other tools: Task 5.
}
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 5: 其它工具的匹配

**Files:**
- Modify: `src/agent/permission-rules.ts`
- Test: `src/agent/permission-rules.test.ts`

**Interfaces:**
- Consumes: Task 3、4 的 `ruleMatches`、`PATH_TOOLS`。
- Produces: `ruleMatches` 对全部工具生效：`web_fetch` 按主机名，`dispatch_agent` / `ask_model` 按角色，`memory_save` / `memory_delete` 按名称，其余只按工具名。另导出内部用的 `hostOf`（任务 7 的归纳要用）。

- [ ] **Step 1: 写失败的测试**

文件末尾追加：

```ts
describe('other tools', () => {
  const call = (name: string, input: Record<string, unknown>): PermissionCall => ({ name, input, cwd: '/work' });

  test('web_fetch rules match the host, case-insensitively, and *.domain covers subdomains', () => {
    const allowed = rule('web_fetch(github.com)');
    expect(ruleMatches(allowed, call('web_fetch', { url: 'https://GitHub.com/a/b?x=1' }))).toBe(true);
    expect(ruleMatches(allowed, call('web_fetch', { url: 'https://raw.github.com/a' }))).toBe(false);

    const sub = rule('web_fetch(*.example.com)');
    expect(ruleMatches(sub, call('web_fetch', { url: 'https://api.example.com/x' }))).toBe(true);
    expect(ruleMatches(sub, call('web_fetch', { url: 'https://example.com/x' }))).toBe(false);

    expect(ruleMatches(rule('web_fetch'), call('web_fetch', { url: 'https://anywhere.test' }))).toBe(true);
  });

  test('roles and memory names must be identical; the rest are whole-tool rules', () => {
    const role = call('dispatch_agent', { role: 'research', task: 'x' });
    expect(ruleMatches(rule('dispatch_agent(research)'), role)).toBe(true);
    expect(ruleMatches(rule('dispatch_agent(review)'), role)).toBe(false);
    expect(ruleMatches(rule('ask_model', 'deny'), call('ask_model', { role: 'research' }))).toBe(true);

    const save = call('memory_save', { name: 'team-conventions', type: 'user', content: 'x' });
    expect(ruleMatches(rule('memory_save(team-conventions)'), save)).toBe(true);
    expect(ruleMatches(rule('memory_save(other)'), save)).toBe(false);
    expect(ruleMatches(rule('memory_delete', 'deny'), call('memory_delete', { name: 'x' }))).toBe(true);
    expect(ruleMatches(rule('todo_write', 'ask'), call('todo_write', {}))).toBe(true);
  });

  test('a rule never matches a call of another tool', () => {
    expect(ruleMatches(rule('read_file(.env*)', 'deny'), bashCall('cat .env'))).toBe(false);
    expect(ruleMatches(rule('grep(.env*)', 'deny'), fileCall('read_file', '.env'))).toBe(false);
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: FAIL，`web_fetch`、角色、名称的断言失败（现在一律返回 `false`）。

- [ ] **Step 3: 实现**

在 `deniedPathInCommand` 之后、`ruleMatches` 之前插入：

```ts
/** Lower-cased host of a URL; undefined when the URL does not parse. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** `example.com` is one host; `*.example.com` is any host under it. */
function hostMatches(pattern: string, host: string): boolean {
  const lowered = pattern.toLowerCase();
  return lowered.startsWith('*.') ? host.endsWith(lowered.slice(1)) : host === lowered;
}

/** Tools whose object is one input field, compared verbatim. */
const OBJECT_KEY: Readonly<Record<string, string>> = {
  dispatch_agent: 'role',
  ask_model: 'role',
  memory_save: 'name',
  memory_delete: 'name',
};
```

把 `ruleMatches` 换成最终版（先取出 `pattern`，后面各分支用的都是 `string`）：

```ts
/** Whether one rule covers one call. A rule without a pattern covers the whole tool. */
export function ruleMatches(rule: PermissionRule, call: PermissionCall): boolean {
  if (rule.tool !== call.name) return false;
  const pattern = rule.pattern;
  if (pattern === undefined) return true;

  if (rule.tool === 'bash') return bashRuleMatches(pattern, String(call.input.command ?? ''));
  if (PATH_TOOLS.includes(rule.tool)) {
    const target = pathTarget(rule.tool, call.input);
    return target !== undefined && pathMatches(pattern, target, call.cwd);
  }
  if (rule.tool === 'web_fetch') {
    const host = hostOf(String(call.input.url ?? ''));
    return host !== undefined && hostMatches(pattern, host);
  }
  const key = OBJECT_KEY[rule.tool];
  // web_search, todo_write and bash_output never carry a pattern, so this is the last branch.
  return key ? String(call.input[key] ?? '') === pattern : false;
}
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 6: 判定顺序

**Files:**
- Modify: `src/agent/permission-rules.ts`
- Test: `src/agent/permission-rules.test.ts`

**Interfaces:**
- Consumes: Task 3–5 的全部匹配函数。
- Produces:
  - `const PLAN_DENIAL`、`const READONLY_DENIAL`（Global Constraints 里的原文）
  - `interface PermissionGates { isMutating: boolean; readOnly: boolean }`
  - `type PermissionVerdict = { action: 'allow'; allowedBy?: PermissionRule } | { action: 'deny'; message: string; rule?: PermissionRule } | { action: 'ask'; rule?: PermissionRule; alwaysRule?: string }`
  - `function evaluatePermission(call: PermissionCall & PermissionGates, mode: PermissionMode, config: PermissionRuleSet, session: readonly PermissionRule[]): PermissionVerdict`
  - 本任务还给 `alwaysRule` 放一个最简实现（只返回工具名），任务 7 整体替换它。

- [ ] **Step 1: 写失败的测试**

导入改成：

```ts
import {
  PATH_TOOLS,
  PLAN_DENIAL,
  READONLY_DENIAL,
  commandAllowed,
  evaluatePermission,
  loadPermissionRules,
  parsePermissionRules,
  ruleMatches,
  type PermissionCall,
  type PermissionRule,
  type PermissionRuleSet,
  type RuleEffect,
} from './permission-rules.js';
import type { PermissionMode } from './permission.js';
```

文件末尾追加：

```ts
type Gates = { isMutating: boolean; readOnly: boolean };
const WRITE: Gates = { isMutating: true, readOnly: false };
/** A mutating tool call the tool itself calls read-only, like `git status` through bash. */
const SAFE_BASH: Gates = { isMutating: true, readOnly: true };
const READ: Gates = { isMutating: false, readOnly: false };

const gated = (name: string, input: Record<string, unknown>, gates: Gates): PermissionCall & Gates => ({
  name,
  input,
  cwd: '/work',
  ...gates,
});
const ruleSet = (permissions: Record<string, string[]>): PermissionRuleSet =>
  parsePermissionRules({ permissions }, TOOLS);
const the = (set: PermissionRuleSet, effect: RuleEffect): PermissionRule =>
  set.rules.find((rule) => rule.effect === effect)!;

describe('evaluatePermission', () => {
  const none: PermissionRuleSet = { rules: [], invalid: [] };
  const denialFor = (text: string): string =>
    `Permission denied by rule "${text}". Do not retry this call; choose another approach, ` +
    'or tell the user if it is required.';

  test('read-only and plan modes refuse mutations before any rule is consulted', () => {
    const edit = gated('edit_file', { path: 'src/a.ts' }, WRITE);
    const allowEverything = ruleSet({ allow: ['edit_file'] });
    expect(evaluatePermission(edit, 'readonly', allowEverything, [])).toEqual({
      action: 'deny',
      message: READONLY_DENIAL,
    });
    expect(evaluatePermission(edit, 'plan', allowEverything, [])).toEqual({
      action: 'deny',
      message: PLAN_DENIAL,
    });
  });

  test('a deny rule refuses without asking, even in auto mode, and names the rule', () => {
    const push = gated('bash', { command: 'git push origin main' }, WRITE);
    const config = ruleSet({ allow: ['bash'], deny: ['bash(git push*)'] });
    expect(evaluatePermission(push, 'auto', config, [])).toEqual({
      action: 'deny',
      rule: the(config, 'deny'),
      message: denialFor('bash(git push*)'),
    });
  });

  test('a denied path inside a read-only bash command is refused', () => {
    const cat = gated('bash', { command: 'cat .env' }, SAFE_BASH);
    const config = ruleSet({ deny: ['read_file(.env*)'] });
    expect(evaluatePermission(cat, 'ask', config, [])).toEqual({
      action: 'deny',
      rule: the(config, 'deny'),
      message: denialFor('read_file(.env*)'),
    });
  });

  test('an ask rule asks, even for a call that would pass silently, and then offers no "always"', () => {
    const status = gated('bash', { command: 'git status' }, SAFE_BASH);
    const config = ruleSet({ allow: ['bash'], ask: ['bash(git status*)'] });
    expect(evaluatePermission(status, 'auto', config, [])).toEqual({ action: 'ask', rule: the(config, 'ask') });
  });

  test('calls that need no permission pass, whatever the allow rules say', () => {
    expect(evaluatePermission(gated('read_file', { path: 'src/a.ts' }, READ), 'ask', none, [])).toEqual({
      action: 'allow',
    });
    expect(evaluatePermission(gated('bash', { command: 'ls -la' }, SAFE_BASH), 'ask', none, [])).toEqual({
      action: 'allow',
    });
  });

  test('an allow rule spares the question and is reported', () => {
    const run = gated('bash', { command: 'npm test -- --watch' }, WRITE);
    const config = ruleSet({ allow: ['bash(npm test*)'] });
    expect(evaluatePermission(run, 'ask', config, [])).toEqual({ action: 'allow', allowedBy: the(config, 'allow') });
  });

  test('deny outranks ask, which outranks allow', () => {
    const push = gated('bash', { command: 'git push origin main' }, WRITE);
    const all = ruleSet({ deny: ['bash(git push*)'], ask: ['bash(git*)'], allow: ['bash'] });
    expect(evaluatePermission(push, 'ask', all, []).action).toBe('deny');
    expect(evaluatePermission(push, 'ask', ruleSet({ ask: ['bash(git*)'], allow: ['bash'] }), []).action).toBe('ask');
    expect(evaluatePermission(push, 'ask', ruleSet({ allow: ['bash'] }), []).action).toBe('allow');
  });

  test('without a rule the mode decides, and a question carries the rule "always" would remember', () => {
    const run = gated('bash', { command: 'npm test' }, WRITE);
    expect(evaluatePermission(run, 'auto', none, [])).toEqual({ action: 'allow' });
    expect(evaluatePermission(run, 'ask', none, [])).toEqual({ action: 'ask', alwaysRule: 'bash' });
  });

  test('configured deny and ask outrank a rule remembered in this session', () => {
    const push = gated('bash', { command: 'git push origin main' }, WRITE);
    const remembered: PermissionRule = {
      effect: 'allow',
      tool: 'bash',
      pattern: 'git push*',
      source: 'session',
      text: 'bash(git push*)',
    };
    expect(evaluatePermission(push, 'ask', ruleSet({ deny: ['bash(git push*)'] }), [remembered]).action).toBe('deny');
    const asked = ruleSet({ ask: ['bash(git push*)'] });
    expect(evaluatePermission(push, 'ask', asked, [remembered])).toEqual({ action: 'ask', rule: the(asked, 'ask') });
    expect(evaluatePermission(push, 'ask', none, [remembered])).toEqual({ action: 'allow', allowedBy: remembered });
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: FAIL，`evaluatePermission` / `PLAN_DENIAL` / `READONLY_DENIAL` 未定义。

- [ ] **Step 3: 实现**

顶部加上类型导入：

```ts
import type { PermissionMode } from './permission.js';
```

在 `ruleMatches` 之后追加：

```ts
/** What the model is told when the mode, not a rule, refuses a mutation. */
export const PLAN_DENIAL =
  'Plan mode is read-only: mutations are disabled. Finish exploring and output the ' +
  'numbered implementation plan (end with the line PLAN READY). The user will approve ' +
  'it before any changes are made.';
export const READONLY_DENIAL =
  'Readonly mode: mutations are disabled. Only read-only tools and commands are available.';

export type PermissionVerdict =
  | { action: 'allow'; allowedBy?: PermissionRule }
  | { action: 'deny'; message: string; rule?: PermissionRule }
  | { action: 'ask'; rule?: PermissionRule; alwaysRule?: string };

/** Whether the call would need permission at all. */
export interface PermissionGates {
  isMutating: boolean;
  /** The tool says this particular call only reads. */
  readOnly: boolean;
}

const denialFor = (rule: PermissionRule): string =>
  `Permission denied by rule "${rule.text}". Do not retry this call; choose another approach, ` +
  'or tell the user if it is required.';

/**
 * One decision for every tool call, in this order: the mode, deny rules,
 * ask rules, calls that need no permission, allow rules, then the mode
 * again. Rules remembered in this session count as allow or deny rules,
 * but a configured deny or ask outranks them.
 */
export function evaluatePermission(
  call: PermissionCall & PermissionGates,
  mode: PermissionMode,
  config: PermissionRuleSet,
  session: readonly PermissionRule[],
): PermissionVerdict {
  if ((mode === 'readonly' || mode === 'plan') && call.isMutating && !call.readOnly) {
    return { action: 'deny', message: mode === 'plan' ? PLAN_DENIAL : READONLY_DENIAL };
  }

  const everything = [...config.rules, ...session];
  const denies = everything.filter((rule) => rule.effect === 'deny');
  const denied =
    denies.find((rule) => ruleMatches(rule, call)) ??
    (call.name === 'bash'
      ? deniedPathInCommand(String(call.input.command ?? ''), denies, call)
      : undefined);
  if (denied) return { action: 'deny', rule: denied, message: denialFor(denied) };

  const asked = config.rules.find((rule) => rule.effect === 'ask' && ruleMatches(rule, call));
  if (asked) return { action: 'ask', rule: asked };

  if (!call.isMutating || call.readOnly) return { action: 'allow' };

  const allows = everything.filter((rule) => rule.effect === 'allow');
  const allowed =
    call.name === 'bash'
      ? commandAllowed(String(call.input.command ?? ''), allows)
      : allows.find((rule) => ruleMatches(rule, call));
  if (allowed) return { action: 'allow', allowedBy: allowed };

  if (mode === 'auto') return { action: 'allow' };
  return { action: 'ask', alwaysRule: alwaysRule(call, call.cwd, 'allow').text };
}

/** The rule "always" remembers for this call. Minimal here; Task 7 derives it by category. */
function alwaysRule(call: Pick<PermissionCall, 'name' | 'input'>, _cwd: string, effect: RuleEffect): PermissionRule {
  return { effect, tool: call.name, source: 'session', text: call.name };
}
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: PASS，9 条全过。其中 `alwaysRule` 那条此刻断言的是 `bash`，任务 7 会把它改成 `bash(npm test*)`。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 7: 「总是允许」的归纳与会话规则

**Files:**
- Modify: `src/agent/permission-rules.ts`
- Test: `src/agent/permission-rules.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `toPosix`、Task 5 的 `hostOf`、Task 6 的 `alwaysRule` 占位。
- Produces:
  - `function alwaysRule(call: Pick<PermissionCall, 'name' | 'input'>, cwd: string, effect: 'allow' | 'deny'): PermissionRule`
  - `function rememberAlways(call: Pick<PermissionCall, 'name' | 'input'>, cwd: string, effect: 'allow' | 'deny'): PermissionRule`
  - `function getSessionRules(): PermissionRule[]`
  - `function clearSessionRules(): number`

- [ ] **Step 1: 写失败的测试**

导入里加上 `alwaysRule`、`clearSessionRules`、`getSessionRules`、`rememberAlways`（按字母序并进已有的导入）。

任务 6 那条 `without a rule the mode decides…` 里的断言改成归纳后的文本：

```ts
    expect(evaluatePermission(run, 'ask', none, [])).toEqual({ action: 'ask', alwaysRule: 'bash(npm test*)' });
```

文件末尾追加：

```ts
describe('alwaysRule', () => {
  const at = (name: string, input: Record<string, unknown>): PermissionRule =>
    alwaysRule({ name, input }, '/work', 'allow');

  test('a plain single-segment command is remembered by its first two words', () => {
    expect(at('bash', { command: 'npm test -- --watch' }).text).toBe('bash(npm test*)');
    expect(at('bash', { command: 'git status --short' }).text).toBe('bash(git status*)');
    expect(at('bash', { command: 'CI=1 cargo test' }).text).toBe('bash(cargo test*)');
    expect(at('bash', { command: 'bun test src/a.test.ts' }).text).toBe('bash(bun test*)');
  });

  test('these commands are remembered verbatim', () => {
    const verbatim = [
      'rm -rf build', // the second word is a flag
      'ls -la',
      'curl -sL https://example.com',
      'find . -name x',
      'sh -c "rm -rf build"', // an interpreter
      'python3 scripts/build.py',
      'node -e "process.exit()"',
      'npm exec prettier', // a subcommand that runs an arbitrary package
      'bun -e "console.log(1)"',
      'bun x prettier',
      'bun scripts/build.ts',
      'npm test && rm -rf build', // several segments
      'npm test $(rm -rf build)', // not safe to parse
    ];
    for (const command of verbatim) {
      expect(at('bash', { command }).text).toBe(`bash(${command})`);
    }
  });

  test('a one-word command is remembered as written', () => {
    expect(at('bash', { command: 'ls' }).text).toBe('bash(ls)');
    expect(at('bash', { command: 'FOO=1 ls' }).text).toBe('bash(FOO=1 ls)');
  });

  test('file edits are remembered by their directory, or by the file at the workspace root', () => {
    expect(at('edit_file', { path: 'src/agent/loop.ts' }).text).toBe('edit_file(src/agent/**)');
    expect(at('write_file', { path: './docs/roadmap.md' }).text).toBe('write_file(docs/**)');
    expect(at('edit_file', { path: 'README.md' }).text).toBe('edit_file(README.md)');
  });

  test('the rest are remembered by host, role, object or tool', () => {
    expect(at('web_fetch', { url: 'https://GitHub.com/a/b' }).text).toBe('web_fetch(github.com)');
    expect(at('dispatch_agent', { role: 'research', task: 'x' }).text).toBe('dispatch_agent(research)');
    expect(at('ask_model', { role: 'review', prompt: 'x' }).text).toBe('ask_model(review)');
    expect(at('grep', { pattern: 'x', path: 'src' }).text).toBe('grep(src)');
    expect(at('glob', { pattern: '**/*.ts' }).text).toBe('glob(**/*.ts)');
    expect(at('web_search', { query: 'x' }).text).toBe('web_search');
    expect(at('memory_save', { name: 'a-b', type: 'user', content: 'x' }).text).toBe('memory_save');
  });
});

describe('session rules', () => {
  test('remembered rules are listed, a later rule with the same text replaces the earlier one, and they clear together', () => {
    clearSessionRules();
    const first = rememberAlways({ name: 'bash', input: { command: 'npm test' } }, '/work', 'allow');
    expect(first.text).toBe('bash(npm test*)');
    rememberAlways({ name: 'edit_file', input: { path: 'src/a.ts' } }, '/work', 'allow');

    expect(getSessionRules().map((rule) => rule.text)).toEqual(['bash(npm test*)', 'edit_file(src/**)']);

    rememberAlways({ name: 'bash', input: { command: 'npm test' } }, '/work', 'deny');
    expect(getSessionRules().map((rule) => [rule.effect, rule.text])).toEqual([
      ['allow', 'edit_file(src/**)'],
      ['deny', 'bash(npm test*)'],
    ]);

    expect(clearSessionRules()).toBe(2);
    expect(getSessionRules()).toEqual([]);
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: FAIL，`rememberAlways` 等不是函数；`alwaysRule` 的断言失败。

- [ ] **Step 3: 实现**

把任务 6 放的占位 `alwaysRule`（连同它上面那行注释）整体替换成：

```ts
/** Commands that run whatever they are given: remembered verbatim, never by a prefix. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'cmd', 'powershell', 'pwsh',
  'python', 'python2', 'python3', 'node', 'ruby', 'perl', 'php', 'lua', 'osascript',
  'xargs', 'env', 'eval', 'exec', 'source', 'sudo', 'doas', 'su', 'nohup', 'watch',
]);
/** Subcommands that run an arbitrary package or code. */
const RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(['exec', 'x', 'dlx', 'create', 'eval']);
/** A word that names a subcommand or a target: not a flag, a path or a value. */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `npm test -- --watch` becomes `npm test*`; anything that hides what runs stays as written. */
function commandAlwaysPattern(command: string): string {
  const { segments, unsafe } = parseSegments(command);
  const only = segments.length === 1 ? segments[0] : undefined;
  if (unsafe || !only) return collapse(command);

  const words = stripAssignments(only.tokens);
  if (words.length <= 1) return only.raw;
  const generalizable =
    !INTERPRETERS.has(words[0]!) && PLAIN_WORD.test(words[1]!) && !RUNNER_SUBCOMMANDS.has(words[1]!);
  return generalizable ? `${words[0]} ${words[1]}*` : only.raw;
}

/** `src/agent/loop.ts` becomes `src/agent/**`; a file at the workspace root stays a file. */
function fileAlwaysPattern(target: string, cwd: string): string {
  const absolute = path.resolve(cwd, target);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return absolute;
  const posix = toPosix(relative);
  const cut = posix.lastIndexOf('/');
  return cut === -1 ? posix : `${posix.slice(0, cut)}/**`;
}

/**
 * The rule "always" remembers for this call — by category, so that the next
 * call of the same kind is spared too. It is shown in the question before
 * it is remembered.
 */
export function alwaysRule(
  call: Pick<PermissionCall, 'name' | 'input'>,
  cwd: string,
  effect: 'allow' | 'deny',
): PermissionRule {
  const { name, input } = call;
  const text = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  };

  let pattern: string | undefined;
  if (name === 'bash') pattern = commandAlwaysPattern(String(input.command ?? ''));
  else if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
    const target = text('path');
    pattern = target ? fileAlwaysPattern(target, cwd) : undefined;
  } else if (name === 'glob') pattern = text('path') ?? text('pattern');
  else if (name === 'grep') pattern = text('path');
  else if (name === 'web_fetch') pattern = hostOf(String(input.url ?? ''));
  else if (name === 'dispatch_agent' || name === 'ask_model') pattern = text('role');

  return { effect, tool: name, pattern, source: 'session', text: ruleText(name, pattern) };
}

let sessionRules: PermissionRule[] = [];

/**
 * Remembers the rule "always" derives from this call. A rule with the same
 * text is replaced, so a later "always reject" wins over an earlier "always allow".
 */
export function rememberAlways(
  call: Pick<PermissionCall, 'name' | 'input'>,
  cwd: string,
  effect: 'allow' | 'deny',
): PermissionRule {
  const rule = alwaysRule(call, cwd, effect);
  sessionRules = [...sessionRules.filter((item) => item.text !== rule.text), rule];
  return rule;
}

export function getSessionRules(): PermissionRule[] {
  return [...sessionRules];
}

/** Forgets everything remembered in this session; returns how many rules that was. */
export function clearSessionRules(): number {
  const count = sessionRules.length;
  sessionRules = [];
  return count;
}
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: PASS，任务 6 那条也通过。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 8: `/permissions` 的文本与启动提示

**Files:**
- Modify: `src/agent/permission-rules.ts`
- Test: `src/agent/permission-rules.test.ts`

**Interfaces:**
- Consumes: `PermissionRule`、`PermissionRuleSet`、`EFFECTS`。
- Produces:
  - `function renderPermissionRules(mode: PermissionMode, config: PermissionRuleSet, session: readonly PermissionRule[]): string`
  - `function invalidRulesWarning(config: PermissionRuleSet): string | undefined`（REPL 对话区的一行，中文）
  - `function invalidRulesNotice(config: PermissionRuleSet): string | undefined`（ACP 写到 stderr 的一行，英文）

- [ ] **Step 1: 写失败的测试**

导入里加上 `invalidRulesNotice`、`invalidRulesWarning`、`renderPermissionRules`。

文件末尾追加：

```ts
describe('renderPermissionRules', () => {
  test('lists the mode, the configured rules by effect, miswritten rules and this session', () => {
    const config = parsePermissionRules(
      {
        permissions: {
          allow: ['bash(npm test*)', 'bash(git diff*)'],
          ask: ['bash(git push*)'],
          deny: ['read_file(**/.env*)'],
        },
      },
      TOOLS,
    );
    const broken = parsePermissionRules({ permissions: { deny: ['bash('] } }, TOOLS);
    const session = [alwaysRule({ name: 'bash', input: { command: 'ls' } }, '/work', 'allow')];

    const text = renderPermissionRules(
      'ask',
      { rules: [...config.rules, ...broken.rules], invalid: broken.invalid },
      session,
    );

    expect(text).toBe(
      [
        'Permission mode: ask',
        'Rules from ~/.transcode.json:',
        '  allow  bash(npm test*) · bash(git diff*)',
        '  ask    bash(git push*)',
        '  deny   read_file(**/.env*)',
        'Invalid rules (ignored):',
        "  bash(  — missing ')'",
        'This session:',
        '  allow  bash(ls)',
        '/permissions clear — forget the rules remembered in this session',
      ].join('\n'),
    );
  });

  test('says so when nothing is configured or remembered', () => {
    expect(renderPermissionRules('auto', { rules: [], invalid: [] }, [])).toBe(
      ['Permission mode: auto', 'Rules from ~/.transcode.json: (none)'].join('\n'),
    );
  });
});

describe('messages about ignored rules', () => {
  test('one line each when rules were ignored, nothing otherwise', () => {
    const broken = parsePermissionRules({ permissions: { allow: ['nope', 'bash('] } }, TOOLS);
    expect(invalidRulesWarning(broken)).toBe('⚠ 2 条权限规则写错了，已忽略。输入 /permissions 查看详情。');
    expect(invalidRulesNotice(broken)).toBe('[transcode] 2 invalid permission rule(s) in the config were ignored');

    const clean: PermissionRuleSet = { rules: [], invalid: [] };
    expect(invalidRulesWarning(clean)).toBeUndefined();
    expect(invalidRulesNotice(clean)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: FAIL，三个函数未定义。

- [ ] **Step 3: 实现**

文件末尾追加：

```ts
const effectList = (rules: readonly PermissionRule[], effect: RuleEffect): string =>
  rules.filter((rule) => rule.effect === effect).map((rule) => rule.text).join(' · ');

/** The text of `/permissions`. */
export function renderPermissionRules(
  mode: PermissionMode,
  config: PermissionRuleSet,
  session: readonly PermissionRule[],
): string {
  const lines = [`Permission mode: ${mode}`, 'Rules from ~/.transcode.json:'];
  for (const effect of EFFECTS) {
    const text = effectList(config.rules, effect);
    if (text) lines.push(`  ${effect.padEnd(5)}  ${text}`);
  }
  if (lines.length === 2) lines[1] += ' (none)';

  if (config.invalid.length > 0) {
    lines.push('Invalid rules (ignored):');
    for (const item of config.invalid) lines.push(`  ${item.raw}  — ${item.reason}`);
  }

  const remembered = EFFECTS.flatMap((effect) => {
    const text = effectList(session, effect);
    return text ? [`  ${effect.padEnd(5)}  ${text}`] : [];
  });
  if (remembered.length > 0) {
    lines.push('This session:', ...remembered, '/permissions clear — forget the rules remembered in this session');
  }
  return lines.join('\n');
}

/** One line for the REPL when configured rules had to be ignored. */
export function invalidRulesWarning(config: PermissionRuleSet): string | undefined {
  return config.invalid.length > 0
    ? `⚠ ${config.invalid.length} 条权限规则写错了，已忽略。输入 /permissions 查看详情。`
    : undefined;
}

/** One line for stderr (ACP) when configured rules had to be ignored. */
export function invalidRulesNotice(config: PermissionRuleSet): string | undefined {
  return config.invalid.length > 0
    ? `[transcode] ${config.invalid.length} invalid permission rule(s) in the config were ignored`
    : undefined;
}
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/agent/permission-rules.test.ts`
Expected: PASS，整个文件全绿。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 9: 接进 Agent 循环，透传给子 agent

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/tools/types.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/tools/dispatch.ts`（约第 130 行）
- Modify: `src/agent/loop.test.ts`（只加配置隔离）
- Create: `src/permission-rules.integration.test.ts`

**Interfaces:**
- Consumes: `evaluatePermission`、`getSessionRules`、`loadPermissionRules`、`PLAN_DENIAL`。
- Produces:
  - `AgentLoopOptions.permissionMode?: PermissionMode`（缺省为 `ask`；`planMode: true` 优先）
  - `PermissionRequest.alwaysRule?: string`
  - `AgentEvent` 的 `tool_result` 分支多一个 `allowedBy?: string`
  - `ToolContext.permissionMode?: PermissionMode`；`ToolContext.requestPermission` 的参数多一个 `alwaysRule?: string`
  - `AGENT_TOOL_NAMES: readonly string[]`（`src/agent/tools/index.ts`）

- [ ] **Step 1: 写失败的测试**

新建 `src/permission-rules.integration.test.ts`。循环不认 `permissionMode` 之前，带规则的用例会失败。

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { PermissionMode } from './agent/permission.js';
import { resetPermissionMode } from './agent/permission.js';
import {
  PLAN_DENIAL,
  READONLY_DENIAL,
  clearSessionRules,
  getSessionRules,
  rememberAlways,
} from './agent/permission-rules.js';
import { AGENT_TOOLS } from './agent/tools/index.js';
import { runAgentLoop, type AgentEvent, type PermissionRequest } from './agent/loop.js';

/**
 * Permission rules where they bite: first in the agent loop. A scripted
 * model replaces createModel for the whole file, because mock.module is
 * process-wide: everything that needs it lives here and the real exports
 * go back afterwards.
 */

/**
 * Credential and gateway variables inherited from the developer's shell.
 * They must not leak into this file: nothing here should ever be able to
 * reach a real endpoint.
 */
const ISOLATED_ENV = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'TRANSCODE_MODEL',
  'TRANSCODE_API_KEY',
];
const DIR_OVERRIDES = ['TRANSCODE_CONFIG_PATH', 'TRANSCODE_SESSIONS_DIR', 'TRANSCODE_USER_DIR'];

let real: typeof import('./provider/provider.js');
let savedEnv: Record<string, string | undefined> = {};
let root: string;

/**
 * One step per model request; the step advances with each request that
 * carries the same user text. The keyword in that text picks the script.
 */
let lastUser = '';
let step = 0;
const scriptedModel = {
  config: { name: 'Scripted Model' },
  model: {
    bindTools: () => ({
      async stream(messages: BaseMessage[]) {
        const user = String(messages.filter((message) => message.getType() === 'human').at(-1)?.content ?? '');
        step = user === lastUser ? step + 1 : 0;
        lastUser = user;
        const call = (id: string, name: string, args: Record<string, unknown>) =>
          new AIMessageChunk({
            content: '',
            tool_call_chunks: [{ id, name, args: JSON.stringify(args), index: 0 }],
          });

        let chunk = new AIMessageChunk({ content: 'scripted reply' });
        if (user.includes('SCRIPT_SAVE') && step < 2) {
          chunk = call(`m${step}`, 'memory_save', {
            name: step === 0 ? 'probe-one' : 'probe-two',
            type: 'user',
            content: 'probe',
          });
        } else if (step === 0 && user.includes('SCRIPT_BASH')) {
          chunk = call('b1', 'bash', { command: 'npm test' });
        } else if (step === 0 && user.includes('SCRIPT_VERSION')) {
          chunk = call('v1', 'bash', { command: 'bun --version' });
        } else if (step === 0 && user.includes('SCRIPT_EDIT')) {
          chunk = call('e1', 'edit_file', {
            path: 'docs/roadmap.md',
            edits: [{ old_string: '# x', new_string: '# y' }],
          });
        } else if (step === 0 && user.includes('SUB_BASH')) {
          chunk = call('s1', 'bash', { command: 'bun --version' });
        }
        return (async function* () {
          yield chunk;
        })();
      },
    }),
  },
};

const writeConfig = (config: Record<string, unknown>): void => {
  writeFileSync(process.env.TRANSCODE_CONFIG_PATH!, JSON.stringify(config));
};

/** Replays one scripted turn against the real tools, in the temp workspace. */
async function replay(
  steps: Array<{ tool: string; args: string }>,
  options: { mode?: PermissionMode; answer?: boolean } = {},
) {
  let call = 0;
  const model = {
    bindTools: () => ({
      async stream() {
        const current = steps[call++];
        const chunk =
          current === undefined
            ? new AIMessageChunk({ content: 'done' })
            : new AIMessageChunk({
                content: '',
                tool_call_chunks: [{ id: `c${call}`, name: current.tool, args: current.args, index: 0 }],
              });
        return (async function* () {
          yield chunk;
        })();
      },
    }),
  } as unknown as BaseChatModel;

  const events: AgentEvent[] = [];
  const asks: PermissionRequest[] = [];
  await runAgentLoop({
    model,
    cwd: root,
    messages: [new HumanMessage('go')],
    systemPrompt: 'test',
    tools: AGENT_TOOLS,
    permissionMode: options.mode ?? 'ask',
    onEvent: (event) => {
      events.push(event);
    },
    requestPermission: async (request) => {
      asks.push(request);
      return options.answer ?? false;
    },
  });
  return {
    asks,
    results: events.filter(
      (event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result',
    ),
  };
}

beforeAll(async () => {
  // Override ONLY createModel; re-export the real module for everything else
  // (a copy: mock.module replaces a loaded module's exports in place).
  real = { ...(await import('./provider/provider.js')) };
  real.clearRegisteredApiKeys();
  mock.module('./provider/provider.js', () => ({ ...real, createModel: () => scriptedModel }));
});

// mock.module is neither undone by a file boundary nor by mock.restore():
// put the real exports back, or every later file gets the scripted model.
afterAll(() => {
  mock.module('./provider/provider.js', () => real);
});

beforeEach(() => {
  savedEnv = {};
  for (const name of ISOLATED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  root = mkdtempSync(path.join(tmpdir(), 'transcode-permission-rules-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(root, 'config.json');
  writeConfig({});
  process.env.TRANSCODE_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.TRANSCODE_USER_DIR = path.join(root, 'user');
  process.env.TRANSCODE_PERMISSION_MODE = 'ask';
  resetPermissionMode();
  clearSessionRules();
  lastUser = '';
  step = 0;
});

afterEach(() => {
  for (const name of DIR_OVERRIDES) delete process.env[name];
  if (savedEnv['TRANSCODE_PERMISSION_MODE'] === undefined) delete process.env.TRANSCODE_PERMISSION_MODE;
  else process.env.TRANSCODE_PERMISSION_MODE = savedEnv['TRANSCODE_PERMISSION_MODE'];
  for (const name of ISOLATED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  resetPermissionMode();
  clearSessionRules();
  rmSync(root, { recursive: true, force: true });
});

describe('permission rules in the agent loop', () => {
  const version = { tool: 'bash', args: '{"command":"bun --version"}' };
  const npmTest = { tool: 'bash', args: '{"command":"npm test"}' };

  test('an allow rule spares the question and is reported on the tool result', async () => {
    writeConfig({ permissions: { allow: ['bash(bun --version)'] } });

    const { asks, results } = await replay([version]);

    expect(asks).toEqual([]);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.allowedBy).toBe('bash(bun --version)');
  });

  test('a deny rule refuses the call without asking and names the rule', async () => {
    writeConfig({ permissions: { deny: ['bash(bun --version)'] } });

    const { asks, results } = await replay([version]);

    expect(asks).toEqual([]);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.output).toContain('Permission denied by rule "bash(bun --version)".');
  });

  test('an ask rule asks even for a read-only command, and offers no "always"', async () => {
    writeConfig({ permissions: { ask: ['bash(echo hi)'] } });

    const { asks, results } = await replay([{ tool: 'bash', args: '{"command":"echo hi"}' }], { answer: true });

    expect(asks).toHaveLength(1);
    expect(asks[0]).not.toHaveProperty('alwaysRule');
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.output).toContain('hi');
  });

  test('a question caused by the mode carries the rule "always" would remember', async () => {
    const { asks, results } = await replay([npmTest], { answer: false });

    expect(asks).toHaveLength(1);
    expect(asks[0]!.alwaysRule).toBe('bash(npm test*)');
    expect(results[0]!.output).toBe('Permission denied by the client.');
  });

  test('a rule remembered in this session spares the next question', async () => {
    rememberAlways({ name: 'bash', input: { command: 'bun --version' } }, root, 'allow');

    const { asks, results } = await replay([version], { answer: false });

    expect(asks).toEqual([]);
    expect(results[0]!.allowedBy).toBe('bash(bun --version)');
  });

  test('the readonly and plan modes outrank allow rules', async () => {
    writeConfig({ permissions: { allow: ['bash(bun --version)'] } });

    const readonly = await replay([version], { mode: 'readonly' });
    expect(readonly.asks).toEqual([]);
    expect(readonly.results[0]!.output).toBe(READONLY_DENIAL);

    const plan = await replay([version], { mode: 'plan' });
    expect(plan.asks).toEqual([]);
    expect(plan.results[0]!.output).toBe(PLAN_DENIAL);
  });

  test('the mode reaches sub-agents: in auto mode a sub-agent command is not asked about', async () => {
    writeConfig({ routing: { research: 'stub' } });
    const dispatch = {
      tool: 'dispatch_agent',
      args: JSON.stringify({ role: 'research', task: 'run SUB_BASH', tools: ['bash'] }),
    };

    const { asks, results } = await replay([dispatch], { mode: 'auto' });

    expect(asks).toEqual([]);
    expect(results[0]!.ok).toBe(true);
  });
});
```

文件顶部还缺三个导入，加在 `import { AIMessageChunk, ... }` 那一行之前：

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/permission-rules.integration.test.ts`
Expected: FAIL。带 allow / deny / ask 规则的用例失败：循环此刻不读规则，该问的照问、该拒的没拒；`results[0].allowedBy` 为 `undefined`；子 agent 那条里 `asks` 不是空的。

- [ ] **Step 3: 实现——`loop.ts`**

在 `import { askRole, getRouting } from '../provider/provider.js';` 之后加：

```ts
import {
  evaluatePermission,
  getSessionRules,
  loadPermissionRules,
  PLAN_DENIAL,
} from './permission-rules.js';
import type { PermissionMode } from './permission.js';
```

`AgentEvent` 的 `tool_result` 分支，在 `skippedPermission?: boolean;` 之后加：

```ts
      /** The rule that allowed a mutating call without asking. */
      allowedBy?: string;
```

`PermissionRequest`，在 `input: Record<string, unknown>;` 之后加：

```ts
  /** The rule "always allow" would remember; absent when a configured `ask` rule caused the question. */
  alwaysRule?: string;
```

`AgentLoopOptions`，在 `planMode?: boolean;` 之后加：

```ts
  /**
   * Permission mode for this run, ask when omitted: the mode gates
   * mutations, then the configured and session rules apply. `planMode: true`
   * overrides it.
   */
  permissionMode?: PermissionMode;
```

`runAgentLoop` 里有两个 `const toolSession = options.toolSession ?? createToolSession(options.cwd);`，在**第二个**（`runAgentLoop` 内、`const recentKeys` 之前那一个）之后加：

```ts
  // A rule may only name tools this run can call.
  const ruleToolNames = (options.tools ?? AGENT_TOOLS).map((item) => item.name);
```

把这两行：

```ts
      let skippedPermission = false;
```

改成：

```ts
      let skippedPermission = false;
      let allowedBy: string | undefined;
```

把从 `      if (!tool) {` 到它下面那个 `else { ... }` 块结束（`totalToolCalls++;` 之前的一行 `      }`）整段替换成：

```ts
      if (!tool) {
        result = { ok: false, output: `Unknown tool: ${call.name}` };
      } else if (occurrences >= 3) {
        result = { ok: false, output: `Error: ${REPEAT_GUIDANCE}` };
      } else {
        // One gate for both surfaces. `planMode: true` keeps meaning plan mode.
        const permissionMode: PermissionMode = options.planMode ? 'plan' : (options.permissionMode ?? 'ask');
        const readOnly = tool.isReadOnly?.(input) === true;
        const verdict = evaluatePermission(
          {
            name: tool.name,
            input,
            cwd: options.cwd,
            shellCwd: toolSession.cwd,
            isMutating: tool.isMutating,
            readOnly,
          },
          permissionMode,
          loadPermissionRules(ruleToolNames),
          getSessionRules(),
        );

        if (verdict.action === 'deny') {
          result = { ok: false, output: verdict.message };
        } else {
          skippedPermission = tool.isMutating && readOnly;
          allowedBy = verdict.action === 'allow' ? verdict.allowedBy?.text : undefined;
          const allowed =
            verdict.action !== 'ask' || !options.requestPermission
              ? true
              : await options.requestPermission({
                  toolCallId,
                  name: tool.name,
                  title,
                  kind: tool.kind,
                  input,
                  ...(verdict.alwaysRule ? { alwaysRule: verdict.alwaysRule } : {}),
                });

          result = allowed
            ? await invokeTool(tool, input, {
                cwd: toolSession.cwd,
                signal: options.signal,
                session: toolSession,
                requestPermission: options.requestPermission,
                permissionMode,
                emit: options.onEvent as (event: { type: 'tool_call' }) => void,
              })
            : { ok: false, output: 'Permission denied by the client.' };

          if (allowed && tool.isMutating && tool.isReadOnly?.(input) !== true) {
            hasActed = true;
            callsSinceAction = 0;
            // "Delivered" means a file write; mutating bash is not a deliverable
            // and must not trigger the wrap-up message.
            if (tool.name === 'write_file' || tool.name === 'edit_file') {
              hasDelivered = true;
            }
          }
        }
      }
```

原来单独的那个 `else if (options.planMode === true && ...Plan mode is read-only...)` 分支随之删掉：方案模式现在由 `evaluatePermission` 用 `PLAN_DENIAL` 拒绝，文字一字不差。

**替换范围的末端别缩短**：新的 `else` 里多了一层 `if (deny) … else …`，所以 `totalToolCalls++;` 之前是**三个**右花括号（原来的代码是两个）。上面代码块的结尾就是三个，要连同它们一起替换。改完先跑 `bun run typecheck` 再跑测试：括号少一个时 `bun test` 不报错，只会空转不退出。

`tool_result` 事件的发出处，在 `skippedPermission,` 之后加一行：

```ts
        allowedBy,
```

- [ ] **Step 4: 实现——`types.ts`、`index.ts`、`dispatch.ts`**

`src/agent/tools/types.ts`：在第一行 `import type { z } from 'zod';` 之后加：

```ts
import type { PermissionMode } from '../permission.js';
```

把 `ToolContext` 里的 `requestPermission` 一项换成：

```ts
  /** Forwarded permission asker, so nested agents respect the same gate. */
  requestPermission?: (request: {
    toolCallId: string;
    name: string;
    title: string;
    kind: ToolKind;
    input: Record<string, unknown>;
    /** The rule "always allow" would remember; absent when a configured `ask` rule caused the question. */
    alwaysRule?: string;
  }) => Promise<boolean>;
```

在 `emit?: ...;` 那一项之后加：

```ts
  /** Permission mode of the run that owns this context, so nested agents are gated the same way. */
  permissionMode?: PermissionMode;
```

`src/agent/tools/index.ts`，在 `export const AGENT_TOOLS: AgentTool[] = [...dispatchPool, dispatchAgentTool];` 之后加：

```ts
/** Names of every registered tool: what a permission rule may name. */
export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOLS.map((item) => item.name);
```

`src/agent/tools/dispatch.ts`，在 `requestPermission: ctx.requestPermission,` 之后加：

```ts
        permissionMode: ctx.permissionMode,
```

- [ ] **Step 5: 给 `loop.test.ts` 隔离配置**

循环现在每次工具调用都读配置，不能让它碰到开发机的 `~/.transcode.json`。`src/agent/loop.test.ts` 第 1 行替换成：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
```

在 `const fakeTool: AgentTool = { ... };` 之后、`describe('runAgentLoop'` 之前插入：

```ts
// The loop reads the permission rules from the config on every tool call:
// keep it away from the developer's ~/.transcode.json.
let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-loop-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  writeFileSync(process.env.TRANSCODE_CONFIG_PATH, '{}');
});
afterEach(() => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  rmSync(configDir, { recursive: true, force: true });
});
```

- [ ] **Step 6: 确认测试通过**

Run: `bun test src/permission-rules.integration.test.ts src/agent/loop.test.ts src/plan-mode.test.ts`
Expected: PASS。任务 9 的 7 条新用例通过；`loop.test.ts` 和 `plan-mode.test.ts` 原有用例不变。

- [ ] **Step 7: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 10: ACP 的三个选项与四种回答

**Files:**
- Create: `src/acp/permissions.ts`
- Create: `src/acp/permissions.test.ts`
- Modify: `src/acp/session.ts`（`prompt` 约 140–151 行，`askPermission` 约 245–285 行）
- Modify: `src/acp/server.ts`（`initialize`，约 70–88 行）
- Test: `src/permission-rules.integration.test.ts`（追加）

**Interfaces:**
- Consumes: `PermissionRequest.alwaysRule`（任务 9）、`rememberAlways`（任务 7）、`invalidRulesNotice` / `loadPermissionRules`（任务 2、8）、`AGENT_TOOL_NAMES`（任务 9）。
- Produces:
  - `function acpPermissionOptions(offerAlways: boolean): AcpPermissionOption[]`
  - `type PermissionChoice = 'once' | 'always' | 'reject' | 'reject_always'`
  - `function permissionChoice(optionId: string | undefined): PermissionChoice`

- [ ] **Step 1: 写失败的测试**

新建 `src/acp/permissions.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';
import { acpPermissionOptions, permissionChoice } from './permissions.js';

describe('acpPermissionOptions', () => {
  test('offers "always" only when remembering a rule can have an effect', () => {
    expect(acpPermissionOptions(true).map((option) => option.optionId)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ]);
    expect(acpPermissionOptions(false).map((option) => option.optionId)).toEqual(['allow_once', 'reject_once']);
  });

  test('every option carries the kind of its answer', () => {
    for (const option of acpPermissionOptions(true)) expect(option.kind).toBe(option.optionId);
  });
});

describe('permissionChoice', () => {
  test('maps what the host answered onto what to do', () => {
    expect(permissionChoice('allow_once')).toBe('once');
    expect(permissionChoice('allow_always')).toBe('always');
    expect(permissionChoice('allow_session')).toBe('always');
    expect(permissionChoice('approve_for_session')).toBe('always');
    expect(permissionChoice('reject_always')).toBe('reject_always');
    expect(permissionChoice('reject_once')).toBe('reject');
    expect(permissionChoice('something_else')).toBe('reject');
    expect(permissionChoice(undefined)).toBe('reject');
  });
});
```

在 `src/permission-rules.integration.test.ts` 的导入里加两行，放在 `./agent/loop.js` 那行之后：

```ts
import { AcpSession } from './acp/session.js';
import type { AcpPermissionRequest } from './acp/protocol.js';
```

文件末尾追加：

```ts
describe('permission answers over ACP', () => {
  /** Memory files the two scripted calls would leave behind. */
  const memories = (): string[] =>
    ['probe-one', 'probe-two'].filter((name) => existsSync(path.join(root, 'user', 'memory', `${name}.md`)));

  /** Runs one prompt; the host answers every permission request with `optionId`. */
  async function promptWith(optionId: string, text = 'SCRIPT_SAVE') {
    const requests: AcpPermissionRequest[] = [];
    const session = new AcpSession(
      {
        sendUpdate: () => {},
        requestPermission: async (request: AcpPermissionRequest) => {
          requests.push(request);
          return { outcome: { outcome: 'selected', optionId } };
        },
      },
      root,
    );
    const result = await session.prompt({ sessionId: session.id, prompt: [{ type: 'text', text }] });
    return { requests, result };
  }

  test('"allow_always" is offered and remembered: the next call of the same kind is not asked about', async () => {
    const { requests, result } = await promptWith('allow_always');

    expect(result.stopReason).toBe('end_turn');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.options.map((option) => option.optionId)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    expect(getSessionRules().map((rule) => rule.text)).toEqual(['memory_save']);
    expect(memories()).toEqual(['probe-one', 'probe-two']);
  });

  test('"reject_always" is remembered as a deny: the next call of the same kind is refused without asking', async () => {
    const { requests } = await promptWith('reject_always');

    expect(requests).toHaveLength(1);
    expect(getSessionRules().map((rule) => [rule.effect, rule.text])).toEqual([['deny', 'memory_save']]);
    expect(memories()).toEqual([]);
  });

  test('"allow_once" behaves as before: every call is asked about and nothing is remembered', async () => {
    const { requests } = await promptWith('allow_once');

    expect(requests).toHaveLength(2);
    expect(getSessionRules()).toEqual([]);
    expect(memories()).toEqual(['probe-one', 'probe-two']);
  });

  test('a question forced by a configured ask rule offers no "always"', async () => {
    writeConfig({ permissions: { ask: ['bash(npm test*)'] } });

    const { requests } = await promptWith('reject_once', 'SCRIPT_BASH');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.options.map((option) => option.optionId)).toEqual(['allow_once', 'reject_once']);
    expect(getSessionRules()).toEqual([]);
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/acp/permissions.test.ts src/permission-rules.integration.test.ts`
Expected: FAIL。`permissions.test.ts` 报找不到模块；集成测试里 `allow_always` 那条的 `requests` 是 2 条、`getSessionRules()` 为空。

- [ ] **Step 3: 实现**

新建 `src/acp/permissions.ts`：

```ts
import type { AcpPermissionOption } from './protocol.js';

/**
 * The choices offered to the host. "Always" is offered only when the
 * question came from the mode: a rule remembered now ranks below a
 * configured `ask` rule, so there it would do nothing.
 */
export function acpPermissionOptions(offerAlways: boolean): AcpPermissionOption[] {
  const once: AcpPermissionOption = { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' };
  const reject: AcpPermissionOption = { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' };
  if (!offerAlways) return [once, reject];
  return [
    once,
    { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
    reject,
  ];
}

export type PermissionChoice = 'once' | 'always' | 'reject' | 'reject_always';

/** What the host's answer means. Anything unknown, or a cancelled question, is a plain reject. */
export function permissionChoice(optionId: string | undefined): PermissionChoice {
  switch (optionId) {
    case 'allow_once':
      return 'once';
    case 'allow_always':
    case 'allow_session':
    case 'approve_for_session':
      return 'always';
    case 'reject_always':
      return 'reject_always';
    default:
      return 'reject';
  }
}
```

`src/acp/session.ts`，在 `import { getPermissionMode } from '../agent/permission.js';` 之后加：

```ts
import { rememberAlways } from '../agent/permission-rules.js';
```

在 `} from './protocol.js';` 之后加：

```ts
import { acpPermissionOptions, permissionChoice } from './permissions.js';
```

`prompt` 里调用 `runAgentLoop` 的参数，在 `planMode,` 之后加：

```ts
        permissionMode: getPermissionMode(),
```

`askPermission` 的 `try { ... } catch` 整块替换成：

```ts
    try {
      const response = await this.host.requestPermission(
        {
          sessionId: this.id,
          toolCall: {
            toolCallId: request.toolCallId,
            title: request.title,
            kind: request.kind,
            status: 'pending',
            rawInput: request.input,
          },
          // "Always" only when remembering a rule can have an effect.
          options: acpPermissionOptions(request.alwaysRule !== undefined),
        },
        signal,
      );

      const choice = permissionChoice(
        response.outcome.outcome === 'selected' ? response.outcome.optionId : undefined,
      );
      const call = { name: request.name, input: request.input };
      if (choice === 'always') rememberAlways(call, this.cwd, 'allow');
      if (choice === 'reject_always') rememberAlways(call, this.cwd, 'deny');
      return choice === 'once' || choice === 'always';
    } catch (error) {
      process.stderr.write(
        `[transcode] permission request failed, denying ${request.name}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return false;
    }
```

`askPermission` 开头的 `auto` / `readonly` 两行捷径保留，作为兜底。

`src/acp/server.ts`，在 `import { loadConfig } from '../config.js';` 之后加：

```ts
import { invalidRulesNotice, loadPermissionRules } from '../agent/permission-rules.js';
import { AGENT_TOOL_NAMES } from '../agent/tools/index.js';
```

`case 'initialize':` 那一段换成：

```ts
      case 'initialize': {
        // ACP has no /permissions: stderr is the only place to say that rules were ignored.
        const notice = invalidRulesNotice(loadPermissionRules(AGENT_TOOL_NAMES));
        if (notice) process.stderr.write(`${notice}\n`);
        return {
          protocolVersion: 1,
          agentInfo: { name: 'transcode', version: VERSION },
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: false,
            },
            mcpCapabilities: {
              http: false,
              sse: false,
            },
          },
          authMethods: [],
        };
      }
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/acp/permissions.test.ts src/permission-rules.integration.test.ts`
Expected: PASS。

- [ ] **Step 5: ACP 冒烟脚本不受影响**

Run: `bun run test:acp`
Expected: 与改动前一样通过（mock 路径不经过规则，宿主仍选 `allow_once`）。

- [ ] **Step 6: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 11: REPL 的三行提示、`a` 键、放行标记与启动提示

**Files:**
- Modify: `src/screens/REPL.tsx`（导入约 40–41 行；`runChat` 约 653、676 行；启动 effect 约 367–375 行；按键约 1394–1405 行；窗口预算约 1760–1769 行；渲染约 1865–1870 行）
- Test: `src/permission-rules.integration.test.ts`（追加）

**Interfaces:**
- Consumes: `PermissionRequest.alwaysRule`、`AgentEvent.allowedBy`（任务 9）、`rememberAlways`、`invalidRulesWarning`、`loadPermissionRules`（任务 2、7、8）、`AGENT_TOOL_NAMES`（任务 9）。
- Produces: 无新接口。REPL 把 `permissionMode` 传给循环；提示三行；`a` 记下 `request.alwaysRule`。

- [ ] **Step 1: 写失败的测试**

`src/permission-rules.integration.test.ts` 的导入里加两行，放在 `import { tmpdir } from 'node:os';` 之前：

```ts
import React from 'react';
import { render } from 'ink-testing-library';
```

`const DIR_OVERRIDES = [...]` 之后加：

```ts
const mounted: ReturnType<typeof render>[] = [];
```

`afterEach(() => {` 的第一行（`for (const name of DIR_OVERRIDES)...` 之前）插入：

```ts
  for (const instance of mounted.splice(0)) instance.unmount();
```

`writeConfig` 之后加 REPL 用的小工具（放在模块顶层，任务 12 也要用）：

```ts
const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the condition holds; a timeout lets the caller's assertion report the stale frame. */
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await settle(40);
  }
}

/** ink-testing-library returns raw ANSI; strip SGR so coloured spans compare as text. */
const frame = (instance: ReturnType<typeof render>): string =>
  (instance.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');

async function mount(): Promise<ReturnType<typeof render>> {
  const { default: REPL } = await import('./screens/REPL.js');
  const instance = render(
    React.createElement(REPL, {
      ctx: { modelId: 'stub', setModelId: () => {}, clearHistory: () => {} },
      banner: { logo: 'LOGO', model: 'stub', dir: '/tmp' },
    }),
  );
  mounted.push(instance);
  await settle();
  return instance;
}

/** Types text, lets the handlers see it, then presses Enter (a burst would hit the slash popup). */
async function submit(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (const ch of text) instance.stdin.write(ch);
  await settle(40);
  instance.stdin.write('\r');
}

/** One key, then a frame: handlers see state one render late. */
async function press(instance: ReturnType<typeof render>, key: string): Promise<void> {
  instance.stdin.write(key);
  await settle(150);
}

const occurrences = (text: string, part: string): number => text.split(part).length - 1;
```

文件末尾追加：

```ts
describe('the permission question in the REPL', () => {
  /** Memory files the two scripted calls would leave behind. */
  const memories = (): string[] =>
    ['probe-one', 'probe-two'].filter((name) => existsSync(path.join(root, 'user', 'memory', `${name}.md`)));

  test('the question offers once / always / reject, and "always" spares the next call of the same kind', async () => {
    const instance = await mount();
    await submit(instance, 'SCRIPT_SAVE');
    await until(() => frame(instance).includes('allow?'));

    const question = frame(instance);
    expect(question).toContain('y  允许这一次');
    expect(question).toContain('a  本会话总是允许  memory_save');
    expect(question).toContain('n  拒绝');

    await press(instance, 'a');
    // The reply only arrives after the second call, which must not have asked again.
    await until(() => frame(instance).includes('scripted reply'));

    expect(getSessionRules().map((rule) => rule.text)).toEqual(['memory_save']);
    expect(memories()).toEqual(['probe-one', 'probe-two']);
  });

  test('"n" refuses once and remembers nothing; Enter still allows once', async () => {
    const instance = await mount();
    await submit(instance, 'SCRIPT_SAVE');
    await until(() => frame(instance).includes('memory_save probe-one'));
    await press(instance, 'n');
    await until(() => frame(instance).includes('memory_save probe-two'));
    await press(instance, '\r');
    await until(() => frame(instance).includes('scripted reply'));

    expect(memories()).toEqual(['probe-two']);
    expect(getSessionRules()).toEqual([]);
  });

  test('the rule offered for "always" is the one derived by category', async () => {
    const instance = await mount();
    await submit(instance, 'SCRIPT_BASH');
    await until(() => frame(instance).includes('allow?'));
    expect(frame(instance)).toContain('a  本会话总是允许  bash(npm test*)');
    await press(instance, 'n');
    await until(() => frame(instance).includes('scripted reply'));

    await submit(instance, 'SCRIPT_EDIT');
    await until(() => frame(instance).includes('patch: docs/roadmap.md'));
    expect(frame(instance)).toContain('a  本会话总是允许  edit_file(docs/**)');
    await press(instance, 'n');
    await until(() => occurrences(frame(instance), 'scripted reply') >= 2);

    expect(getSessionRules()).toEqual([]);
  });

  test('a question forced by a configured ask rule has no "always" line', async () => {
    writeConfig({ permissions: { ask: ['bash(npm test*)'] } });
    const instance = await mount();
    await submit(instance, 'SCRIPT_BASH');
    await until(() => frame(instance).includes('allow?'));

    expect(frame(instance)).toContain('y  允许这一次');
    expect(frame(instance)).not.toContain('本会话总是允许');

    await press(instance, 'n');
    await until(() => frame(instance).includes('scripted reply'));
  });

  test('a call allowed by a rule asks nothing and leaves a marker naming the rule', async () => {
    writeConfig({ permissions: { allow: ['bash(bun --version)'] } });
    const instance = await mount();
    await submit(instance, 'SCRIPT_VERSION');
    await until(() => frame(instance).includes('scripted reply'));
    await settle(300);

    expect(frame(instance)).not.toContain('allow?');
    expect(frame(instance)).toContain('(allowed: bash(bun --version))');
  });
});

describe('the startup warning', () => {
  test('miswritten configured rules are reported once on startup', async () => {
    writeConfig({ permissions: { allow: ['typo('] } });
    const instance = await mount();
    await until(() => frame(instance).includes('⚠ 1 条权限规则写错了'));
    // `until` gives up quietly, so the check itself has to be an assertion.
    expect(frame(instance)).toContain('⚠ 1 条权限规则写错了');
    expect(occurrences(frame(instance), '条权限规则写错了')).toBe(1);
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/permission-rules.integration.test.ts`
Expected: FAIL。第一条在 `expect(question).toContain('a  本会话总是允许  memory_save')` 处失败（提示还是一行 `allow? y/n`）；启动提示那条超时失败；放行标记那条在 `(allowed: …)` 处失败。

- [ ] **Step 3: 实现——导入与传参**

`src/screens/REPL.tsx`：

```ts
import { createToolSession } from '../agent/tools/index.js';
```

改成：

```ts
import { AGENT_TOOL_NAMES, createToolSession } from '../agent/tools/index.js';
```

在 `import { getPermissionMode, nextPermissionMode, ... } from '../agent/permission.js';` 之后加：

```ts
import { invalidRulesWarning, loadPermissionRules, rememberAlways } from '../agent/permission-rules.js';
```

`runChat` 里 `runAgentLoop({ ... })` 的参数，在 `planMode,` 之后加一行：

```ts
          permissionMode: getPermissionMode(),
```

- [ ] **Step 4: 实现——放行标记、启动提示、窗口预算**

工具结果行的标记，把这一行：

```ts
              const marker = event.skippedPermission ? ' ✓ (read-only)' : event.ok ? ' ✓' : ' ✗';
```

换成：

```ts
              const marker = event.skippedPermission
                ? ' ✓ (read-only)'
                : event.allowedBy
                  ? ` ✓ (allowed: ${event.allowedBy})`
                  : event.ok
                    ? ' ✓'
                    : ' ✗';
```

找到调用 `webSearchConfigWarning(loadConfig().webSearch)` 的那个 `useEffect`，在它的 `}, []);` 之后加：

```tsx
  // Miswritten permission rules are ignored; say so once on startup.
  useEffect(() => {
    const warning = invalidRulesWarning(loadPermissionRules(AGENT_TOOL_NAMES));
    if (warning) {
      addHistory({ input: '', output: warning });
      dragFlush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

活动区窗口预算：授权提示从一行变成三行，预算要跟着让出两行。把这四行里的注释和数字改掉：

```ts
  // Wrapped-row budget (review finding: Ink counts folded screen rows, so
  // logical-line budgets blow on long CJK/diff lines): rows-13 with wide
  // chars measured at 2 columns, columns-2 for paddingX. The 13 counts the
  // fixed rows around the tail (turn echo, input box + mode indicator, …).
  const liveTail = sliceLiveTail(
    chat.liveOutput,
    (stdout?.rows ?? 24) - 13,
    (stdout?.columns ?? 80) - 2,
  );
```

换成：

```ts
  // Wrapped-row budget (review finding: Ink counts folded screen rows, so
  // logical-line budgets blow on long CJK/diff lines): rows-15 with wide
  // chars measured at 2 columns, columns-2 for paddingX. The 15 counts the
  // fixed rows around the tail (turn echo, the three-line permission
  // question, input box + mode indicator, …).
  const liveTail = sliceLiveTail(
    chat.liveOutput,
    (stdout?.rows ?? 24) - 15,
    (stdout?.columns ?? 80) - 2,
  );
```

- [ ] **Step 5: 实现——按键与渲染**

`useInput` 里 `if (phase === 'permission') { ... return; }` 这一整块换成：

```ts
    if (phase === 'permission') {
      if (ch === 'y' || ch === 'Y' || key.return) {
        pendingPermissionRef.current?.resolve(true);
        return;
      }
      if (ch === 'a' || ch === 'A') {
        // Offered only when the mode caused the question: a remembered rule
        // ranks below a configured `ask` rule, so "always" would do nothing there.
        const pending = pendingPermissionRef.current;
        if (pending?.request.alwaysRule) {
          rememberAlways({ name: pending.request.name, input: pending.request.input }, process.cwd(), 'allow');
          pending.resolve(true);
        }
        return;
      }
      if (ch === 'n' || ch === 'N') {
        pendingPermissionRef.current?.resolve(false);
        return;
      }
      return;
    }
```

渲染里的授权提示块换成：

```tsx
      {phase === 'permission' && pendingPermissionRef.current && (
        <Box marginLeft={2} flexDirection="column">
          <Text color="yellow">
            ⚙ {pendingPermissionRef.current.request.title} ({pendingPermissionRef.current.request.kind}) — allow?
          </Text>
          <Text color="yellow">  y  允许这一次</Text>
          {pendingPermissionRef.current.request.alwaysRule && (
            <Text color="yellow">  a  本会话总是允许  {pendingPermissionRef.current.request.alwaysRule}</Text>
          )}
          <Text color="yellow">  n  拒绝</Text>
        </Box>
      )}
```

- [ ] **Step 6: 确认测试通过**

Run: `bun test src/permission-rules.integration.test.ts src/screens/mode-indicator.test.ts src/plan-mode.test.ts`
Expected: PASS。新加的 6 条通过；模式角标和方案模式的原有用例不变。

- [ ] **Step 7: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 12: `/permissions` 命令

**Files:**
- Modify: `src/commands.ts`（导入；命令表里 `mode` 之后）
- Test: `src/permission-rules.integration.test.ts`（追加）

**Interfaces:**
- Consumes: `renderPermissionRules`、`loadPermissionRules`、`getSessionRules`、`clearSessionRules`（任务 2、7、8）、`AGENT_TOOL_NAMES`（任务 9）。
- Produces: `/permissions` 与 `/permissions clear`；`findCommand('permissions')` 有定义，`/help` 里列出。

- [ ] **Step 1: 写失败的测试**

`src/permission-rules.integration.test.ts` 文件末尾追加：

```ts
describe('/permissions', () => {
  test('lists the mode, the configured rules, miswritten rules and the rules of this session', async () => {
    writeConfig({ permissions: { allow: ['bash(npm test*)'], deny: ['bash('] } });
    rememberAlways({ name: 'bash', input: { command: 'ls' } }, root, 'allow');

    const instance = await mount();
    await submit(instance, '/permissions');
    await until(() => frame(instance).includes('Permission mode: ask'));

    const text = frame(instance);
    expect(text).toContain('  allow  bash(npm test*)');
    expect(text).toContain("  bash(  — missing ')'");
    expect(text).toContain('  allow  bash(ls)');
  });

  test('/help lists it', async () => {
    const instance = await mount();
    await submit(instance, '/help');
    await until(() => frame(instance).includes('/permissions'));
    expect(frame(instance)).toContain('/permissions');
  });

  test('/permissions clear forgets the rules of this session and says how many', async () => {
    rememberAlways({ name: 'bash', input: { command: 'ls' } }, root, 'allow');

    const instance = await mount();
    await submit(instance, '/permissions clear');
    await until(() => frame(instance).includes('已清空本会话记下的 1 条规则。'));
    expect(getSessionRules()).toEqual([]);

    await submit(instance, '/permissions clear');
    await until(() => frame(instance).includes('本会话没有记下任何规则。'));
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `bun test src/permission-rules.integration.test.ts`
Expected: FAIL，三条都超时：`/permissions` 被当成未知命令（`Unknown command: permissions`）。

- [ ] **Step 3: 实现**

`src/commands.ts`，在 `import { getPermissionMode, PERMISSION_MODES, setPermissionMode } from './agent/permission.js';` 之后加：

```ts
import {
  clearSessionRules,
  getSessionRules,
  loadPermissionRules,
  renderPermissionRules,
} from './agent/permission-rules.js';
import { AGENT_TOOL_NAMES } from './agent/tools/index.js';
```

在 `commands` 数组里 `name: 'mode'` 那一项之后加：

```ts
  {
    name: 'permissions',
    description: 'Show permission rules; "clear" forgets those of this session',
    execute: (args) => {
      if (args[0]?.toLowerCase() === 'clear') {
        const count = clearSessionRules();
        return {
          output: count > 0 ? `已清空本会话记下的 ${count} 条规则。` : '本会话没有记下任何规则。',
        };
      }
      return {
        output: renderPermissionRules(getPermissionMode(), loadPermissionRules(AGENT_TOOL_NAMES), getSessionRules()),
      };
    },
  },
```

- [ ] **Step 4: 确认测试通过**

Run: `bun test src/permission-rules.integration.test.ts src/commands.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `bun run typecheck`
Expected: 无输出。

---

### Task 13: 文档同步

**Files:**
- Modify: `README.md`（命令表约 164–180 行；「工具」一节末尾约 263 行；「渲染与交互」的授权提示一条约 318 行）
- Modify: `docs/ACP.md`（「权限流程」约 144–187 行）
- Modify: `docs/roadmap.md`（阶段一第 1 项）

**Interfaces:**
- Consumes: 前面十二个任务落地的行为。
- Produces: 无代码。文档与实现一致，且不提任何参考实现。

- [ ] **Step 1: README 的命令表**

在「REPL 命令」表里 `/mode [模式]` 那一行之后加：

```markdown
| `/permissions [clear]` | 查看权限模式、配置里的权限规则和本会话记下的规则；`/permissions clear` 清空本会话记下的 |
```

- [ ] **Step 2: README 新增「权限规则」一节**

在 `## 子任务分派` 之前插入：

````markdown
## 权限规则

四种权限模式之上，可以用规则决定哪些调用免问、哪些必问、哪些直接拒绝。规则写在 `~/.transcode.json`：

```jsonc
"permissions": {
  "allow": ["bash(npm test*)", "bash(git diff*)"],
  "ask":   ["bash(git push*)"],
  "deny":  ["read_file(**/.env*)", "edit_file(.transcode/**)", "bash(rm -rf *)"]
}
```

一条规则是 `工具名` 或 `工具名(对象)`，对象按工具分三种：

- **命令**（`bash`）：按词比较。结尾的 `*` 表示“以这些词开头的命令”，没有 `*` 就是整段命令完全相同。`bash(npm test*)` 匹配 `npm test -- --watch`，不匹配 `npm tests`。`a && b` 这类复合命令，allow 要求每一段都被放行，deny 和 ask 只要有一段命中就算。
- **路径**（`read_file`、`write_file`、`edit_file`、`glob`、`grep`）：相对工作区根目录。不含 `/` 的模式按文件名匹配任意深度，`.env*` 连 `config/.env.local` 一起管住；`*` 不跨目录，`**` 跨目录；可以用 `~/`、`/`、`**/` 开头。
- **其它**：`web_fetch(主机名)`、`dispatch_agent(角色)`、`ask_model(角色)`、`memory_save(名称)`、`memory_delete(名称)`；`web_search`、`todo_write`、`bash_output` 只能写工具名。

每次工具调用按这个顺序判定：

1. `readonly` 和 `plan` 模式下，变更类工具直接拒绝。模式高于规则。
2. 命中 deny：拒绝，不询问。`auto` 模式下也生效。
3. 命中 ask：询问。只读命令也会被拦下来问。
4. 只读命令和非变更类工具：放行。
5. 命中 allow：放行，结果行标注 `(allowed: 规则)`。
6. 其余按模式：`auto` 放行，否则询问。

写错的规则不生效，`/permissions` 里会标出原因，启动时提示一行。改完配置，下一次工具调用就生效。

**本会话的“总是允许”**：授权提示里按 `a`，同类调用在本会话内不再问。记住的范围就是提示里显示的那条规则：

| 这次调用 | 记住的规则 |
| --- | --- |
| `bash`，单段命令 | 前两个词加 `*`，如 `bash(npm test*)` |
| `bash`，其余情况 | 命令原文，如 `bash(rm -rf build)` |
| 文件读写，文件在子目录下 | 所在目录：`edit_file(src/agent/**)` |
| 文件读写，文件在工作区根目录 | 该文件本身：`edit_file(README.md)` |
| `glob`、`grep` | 对象原文；没有对象就是工具名 |
| `web_fetch` | `web_fetch(主机名)` |
| `dispatch_agent`、`ask_model` | `工具(角色)`；没有角色就是工具名 |
| 其它（`web_search`、记忆、待办、后台任务输出） | 工具名 |

三点说明：

- bash 命令的第二个词是选项（如 `rm -rf build`），或命令以 `sh`、`python`、`node` 这类解释器开头，或有好几段，都只记命令原文。
- deny 的路径规则还会检查 bash 命令里以字面量出现的路径参数，所以 `cat .env`、`grep x config/.env` 也拦得住。这只是尽力而为：参数经过变量展开，或者文件由程序自己打开，就管不到。
- 因为配置里的 ask 规则弹出的提示没有 `a`：记住的规则压不过配置里的 ask。

`/permissions` 列出权限模式、配置里的规则、写错的规则和本会话记下的规则；`/permissions clear` 清空本会话记下的规则，不动配置文件。
````

- [ ] **Step 3: README 的两处小改**

「渲染与交互」里的这一条：

```markdown
- **授权提示**：`allow? y/n`，`y` 或回车允许这一次，`n` 拒绝
```

换成：

```markdown
- **授权提示**：`y` 或回车允许这一次，`a` 本会话总是允许同类调用（提示里写明将记住的规则），`n` 拒绝。详见「权限规则」
```

「工具」一节里 `所有路径默认限制在任务 workspace…` 那一段之后加一句（单独一行）：

```markdown
上表“是否需要授权”说的是默认行为；命中 allow 规则的调用免问，命中 deny 规则的直接拒绝，见「权限规则」。
```

- [ ] **Step 4: `docs/ACP.md`**

「权限流程」示例里的 `options` 数组换成三个选项：

```json
    "options": [
      { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
      { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" }
    ]
```

在 `选择拒绝或 {"outcome":{"outcome":"cancelled"}} 都会让工具返回失败，但不会中断整个 turn。` 之后加两段：

```markdown
`allow_always` 允许这一次，并在本会话内记住归纳出的一类调用（如 `bash(npm test*)`），之后同类调用不再请求。`reject_always` 拒绝，并把这一类记成拒绝。因为配置里的 `ask` 规则而发出的请求只有「允许一次」和「拒绝」两个选项。

配置里的权限规则（`~/.transcode.json` 的 `permissions`，写法见 README 的「权限规则」）对 ACP 同样生效：命中 deny 直接拒绝、不请求；命中 allow 直接放行、不请求。写错的规则会被忽略，`initialize` 时往 stderr 写一行。
```

- [ ] **Step 5: `docs/roadmap.md`**

在 `### 1. 权限规则 + “总是允许”（中）` 这一行下面加一行：

```markdown

状态：已实现。
```

- [ ] **Step 6: 核对文档与实现**

Run: `grep -n "permissions\|权限规则" README.md docs/ACP.md docs/roadmap.md`
Expected: 三份文档都能搜到新内容；全文搜不到任何参考实现的名字。

人工检查：通读 `docs/roadmap.md`、设计文档和本计划，确认里面没有出现任何其它工具的名称（计划自身也不例外）。
Expected: 没有命中。

---

### Task 14: 全量验证

**Files:** 无新改动。

- [ ] **Step 1: 全量测试**

Run: `bun test`
Expected: 全部通过。基线是 450 条，这次新增约 70 条。`bash.test.ts` 有两条对时间敏感的用例，偶发超时时单独重跑那一个文件再判断。

- [ ] **Step 2: 类型检查与打包**

Run: `bun run typecheck && bun run build`
Expected: typecheck 无输出；`dist/cli.js` 和 `dist/main.js` 构建成功。

- [ ] **Step 3: 真终端看一眼**

按记忆里的 pty 探针做法（临时配置、会话、用户目录，不带任何凭据）启动 `bun bin/transcode.ts`，在配置里放一条 `"deny": ["read_file(**/.env*)"]` 和一条 `"allow": ["bash(bun --version)"]`：

1. 让 Agent 跑 `bun --version`：不弹提示，结果行带 `(allowed: bash(bun --version))`。
2. 让 Agent 跑 `npm test`：弹出三行提示，`a` 行显示 `bash(npm test*)`；按 `n` 拒绝。
3. 输入 `/permissions`：列出那两条规则，没有本会话的规则。
4. 输入 `/exit` 退出，删除临时目录。

Expected: 四步都与上面的描述一致，终端里没有错位或闪烁。

