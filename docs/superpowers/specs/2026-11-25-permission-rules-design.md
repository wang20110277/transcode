# 权限规则与「总是允许」 — 设计

日期：2026-11-25 · 状态：设计已确认（对应 `docs/roadmap.md` 阶段一第 1 项）

## 意图

`ask` 模式下每次变更都要 y / n，且只管一次；ACP 更是只给宿主"允许一次 / 拒绝"两个选项。结果是高频、低风险的调用反复打断，用户被问烦之后只能整体切到 `auto`。

这次给权限加上两层：可配置的**规则**（`~/.transcode.json` 的 allow / ask / deny），和**本会话的「总是允许」**（授权时按一下 `a`，同类调用不再问）。REPL 和 ACP 共用同一套判定。

## 现状

- 模式判定分散在两处：`REPL.tsx` 的 `askInTerminal` 和 `acp/session.ts` 的 `askPermission`，各自写了一遍"`auto` 放行、`readonly` 拒绝、其余询问"。
- `loop.ts` 只判断"是否变更类工具且不是只读命令"，是就调用 `requestPermission`。方案模式由调用方传 `planMode`，在循环里直接拒绝变更。
- 唯一的免确认机制是 bash 的只读命令识别（`tools/read-only.ts`）：一个保守的解析器，把命令按 `; | && ||` 拆段，遇到重定向写入、命令替换、heredoc 一律判为不安全。
- ACP 的类型里已有 `allow_always` / `reject_always`，但没有提供，也没处理。

## 设计

### 规则配置与写法

```jsonc
// ~/.transcode.json
"permissions": {
  "allow": ["bash(npm test*)", "bash(git diff*)"],
  "ask":   ["bash(git push*)"],
  "deny":  ["read_file(**/.env*)", "edit_file(.transcode/**)", "bash(rm -rf *)"]
}
```

一条规则是 `工具名` 或 `工具名(对象)`。括号从第一个 `(` 取到最后一个 `)`，所以对象里可以出现括号。

写错的规则不生效，在 `/permissions` 里标出原因。写错包括：括号不配对、工具名不是已注册的工具、只支持工具名写法的工具带了括号、对象为空。不配置 `permissions` 时行为与现在完全一致。

### 匹配规则

**命令（`bash`）**

- 对象按空白拆成词。结尾的 `*`（单独一词或贴在最后一个词后面）表示"以这些词开头的命令"，按词比较：`bash(npm test*)` 匹配 `npm test`、`npm test -- --watch`，不匹配 `npm tests`。
- 没有 `*` 就是该段命令与对象完全相同，忽略首尾空白和连续空白。
- 按词比较前去掉段首的 `VAR=value` 赋值，与只读识别保持一致。大小写敏感。
- 复合命令复用 `read-only.ts` 的分段：allow 要求命令不含不安全结构（重定向写入、命令替换、heredoc、未闭合引号），且**每一段**都被某条 allow 规则放行；deny 和 ask 只要**有一段**命中就算。
- 不带括号的 `bash` 匹配所有命令。

**路径（`read_file`、`write_file`、`edit_file`、`glob`、`grep`）**

- 对象是 `path` 参数。`glob` 没给 `path` 时取 `pattern`（当文本比较，尽力而为）；`grep` 没给 `path` 时不参与路径匹配，因为它的 `pattern` 是内容正则。路径先 `path.resolve` 归一化再比较。
- 模式相对工作区根目录。以 `~/` 或 `/` 开头按绝对路径匹配；以 `**/` 开头匹配任意深度。
- 不含 `/` 的模式按**文件名**匹配任意深度：`.env*` 连 `config/.env.local` 一起管住。
- `*` 不跨目录，`**` 跨目录，`?` 是普通字符。`目录/**` 同时匹配目录本身。
- macOS 和 Windows 上不区分大小写。

**其它**

- `web_fetch(主机名)`：取 URL 的主机名，小写比较。`*.example.com` 匹配它的任意子域。
- `dispatch_agent(角色)`、`ask_model(角色)`、`memory_save(名称)`、`memory_delete(名称)`：对象与参数完全相同。
- `web_search`、`todo_write`、`bash_output`：只有工具名一种写法。

**deny 的路径规则与 bash**

只读命令现在是直接放行的，`cat .env` 会绕过对 `.env` 的 deny。所以 deny 里的路径规则（不论写的是哪个文件工具）还会检查 bash 命令的各个参数：以 `-` 开头的参数跳过，其余参数去掉首尾的括号后按路径解析（相对 shell 的当前目录），命中即拒绝。这只是尽力而为：参数经过变量展开、拼接或者由程序内部打开的文件管不到。

### 判定顺序

每次工具调用，在循环里按这个顺序判定：

1. **模式**：`readonly` 或 `plan` 下，变更类工具且不是只读调用 → 拒绝。模式高于规则，allow 不能在只读模式下放行变更。
2. **deny**（配置或本会话）命中 → 拒绝，不询问。
3. **ask**（配置）命中 → 询问。只读命令和本来不问的工具也会被拦下来问。
4. **不需要授权**：只读命令，或非变更类工具 → 放行。
5. **allow**（配置或本会话）命中 → 放行，结果行标注 `(allowed: 规则)`。
6. **按模式**：`auto` 放行，否则询问。

本会话记下的规则只比配置低一级：配置里的 deny 和 ask 优先于它。

所以 allow 只对会触发询问的调用有意义：只读命令和非变更类工具在第 4 步已经放行，用不到它。

返回给模型的拒绝说明：

- 方案模式：沿用现有文字（`Plan mode is read-only: …`）。
- 只读模式：`Readonly mode: mutations are disabled. Only read-only tools and commands are available.`
- 规则拒绝：`Permission denied by rule "<规则>". Do not retry this call; choose another approach, or tell the user if it is required.`

子 agent 的权限请求是转发给同一道门的，所以规则对子 agent 同样生效。

### 「总是允许」的归纳

按类别归纳，归纳出的规则在提示里如实显示：

| 这次调用 | 记住的规则 |
| --- | --- |
| `bash`，单段命令 | 前两个词 + `*`，如 `bash(npm test*)` |
| `bash`，其余情况 | 命令原文，如 `bash(rm -rf build)` |
| 文件读写，文件在子目录下 | 所在目录：`edit_file(src/agent/**)` |
| 文件读写，文件在工作区根目录 | 该文件本身：`edit_file(README.md)` |
| `glob`、`grep` | 对象原文；没有对象就是工具名 |
| `web_fetch` | `web_fetch(主机名)` |
| `dispatch_agent`、`ask_model` | `工具(角色)`；没有角色就是工具名 |
| 其它（`web_search`、记忆、待办、后台任务输出） | 工具名 |

bash 归纳成"前两个词"要同时满足三个条件，否则记命令原文：

- 命令只有一段，且不含不安全结构。
- 去掉段首的 `VAR=value` 后，第二个词是普通单词：字母或数字开头，只含字母、数字、`.`、`_`、`-`，且不是 `exec`、`x`、`dlx`、`create`、`eval` 这类"运行任意包或代码"的子命令。所以 `rm -rf build`、`ls -la`、`curl -sL …`、`find . …`、`npm exec …` 都记原文。
- 第一个词不是解释器或万能执行器：`sh` `bash` `zsh` `dash` `fish` `ksh` `cmd` `powershell` `pwsh` `python` `python2` `python3` `node` `ruby` `perl` `php` `lua` `osascript` `xargs` `env` `eval` `exec` `source` `sudo` `doas` `su` `nohup` `watch`。所以 `sh -c "…"`、`python3 scripts/build.py`、`node -e "…"` 记原文。`bun`、`deno` 不在此列：它们同时也是包管理器，`bun test`、`bun run build` 应当像 `npm test` 一样归纳；真正跑任意代码的写法（`bun -e "…"`、`bun x <包>`、`bun scripts/x.ts`）已经被前两个条件拦住。

只有一个词的命令（如 `ls`）记 `bash(ls)`。

根目录下的文件只记该文件，是因为根目录的目录规则等于放行所有文件。

### REPL 提示

```
⚙ npm test (execute) — allow?
  y  允许这一次
  a  本会话总是允许  bash(npm test*)
  n  拒绝
```

- `y` 或回车：允许这一次。`a`：允许，并记下显示的规则。`n`：拒绝。其它按键无效，Esc 仍然是取消整个回合。
- 因为配置里的 ask 规则而弹出的提示，不显示 `a` 行：记下的规则压不过配置里的 ask，按了也没有意义。
- 被规则放行的变更类调用，结果行的标记从 `✓ (read-only)` 那种形式扩成 `✓ (allowed: <规则>)`。只读命令免确认的 `(read-only)` 标记不变。

### ACP

`session/request_permission` 的选项从两个变成三个：

| optionId | name | kind | 处理 |
| --- | --- | --- | --- |
| `allow_once` | Allow once | `allow_once` | 允许这一次 |
| `allow_always` | Always allow | `allow_always` | 允许，并记下归纳出的规则 |
| `reject_once` | Reject | `reject_once` | 拒绝 |

- 宿主回 `allow_session` 或 `approve_for_session` 时按 `allow_always` 处理（这两个旧名字的意思就是"本会话允许"）。
- 宿主回 `reject_always` 时拒绝，并把归纳出的规则记成**本会话的 deny**。
- 因为配置里的 ask 规则而发出的请求，不提供 `allow_always`，只给「允许一次」和「拒绝」。
- multica 这类只会选 `allow_once` 的宿主，行为与现在相同。

### `/permissions` 命令

- `/permissions`：列出当前模式、配置里的规则（按 allow / ask / deny 分组）、写错的规则及原因、本会话记下的规则（标注 allow 或 deny）。
- `/permissions clear`：清空本会话记下的规则，不动配置文件。
- REPL 启动时如果有写错的规则，对话区提示一行；ACP 在 `initialize` 时往 stderr 写一行。

### 模块划分

- 新增 `src/agent/permission-rules.ts`，全部是纯函数或进程内状态：
  - `parsePermissionRules(config)`：读 `permissions` 配置，返回合法规则和带原因的无效项。
  - `ruleMatches(rule, name, input, cwd, shellCwd)`：一条规则是否命中一次调用。
  - `alwaysRule(name, input, kind, cwd, effect)`：按上表归纳。
  - `evaluatePermission(...)`：按判定顺序给出 `allow` / `deny` / `ask`，以及命中的规则、给模型的说明、可用的"总是允许"规则。
  - 本会话规则的增删查：`rememberAlways(request, cwd, effect)`（归纳并记下 allow 或 deny）、`getSessionRules`、`clearSessionRules`。
- `src/agent/tools/read-only.ts`：导出 `parseSegments`，并让它带回每一段的原文，供规则匹配复用。
- `src/agent/loop.ts`：新增 `permissionMode` 选项，不传时按 `ask` 处理（规则照常生效）。每次工具调用先过 `evaluatePermission`，只有结果是 `ask` 时才调用 `requestPermission`。`planMode` 保留，`permissionMode` 为 `plan` 时等同。权限请求对象多带一个 `alwaysRule` 字段（没有则不提供"总是允许"）；工具结果事件多带一个 `allowedBy` 字段（放行的规则）。mock 模式那一处直接调用 `requestPermission` 的写法不变，ACP 冒烟脚本靠它验证权限流程。
- `src/agent/tools/types.ts`：`ToolContext` 增加 `permissionMode`，`dispatch_agent` 把它传给子 agent 的循环。
- `src/agent/permission.ts`：不变。
- `src/config.ts`：`TranscodeConfig` 增加 `permissions?: { allow?: string[]; ask?: string[]; deny?: string[] }`。
- `src/screens/REPL.tsx`：提示改为三行、处理 `a`、结果行的 `(allowed: …)` 标记、启动时的无效规则提示。
- `src/acp/session.ts`：三个选项及四种回答的处理。
- `src/commands.ts`：`permissions` 命令。
- `REPL.tsx` 和 `acp/session.ts` 里现有的 `auto` / `readonly` 捷径保留，作为兜底。

规则每次判定时从配置读取，改完 `~/.transcode.json` 下一次工具调用就生效。

## 非目标

- 项目级规则文件（如 `.transcode/settings.json`）。
- 把"总是允许"写回配置文件，或跨会话保留。
- 按模式分别配置规则。
- 用路径规则完全管住 bash，或解析软链接。
- 交互式增删规则；正则表达式写法。

## 备选（已否）

- **规则匹配放进各个工具**：十四个工具各写一份匹配，会话规则还是得有共享存储，逻辑反而散。
- **由 REPL 和 ACP 各自传入策略回调**：两份策略实现会走偏，现在的模式判定就是这样分散的。
- **命令按字符串前缀匹配**：`git status*` 会匹配到 `git statusx`，边界说不清。按词比较没有这个问题。
- **"总是允许"一律只记完全相同的调用**：换个参数又要问，省不了多少次。用户已选按类别归纳。
- **带选项的命令也归纳成第一个词**：`rm -rf build` 会变成 `rm*`。已否，这类命令记原文。
- **默认自带一组规则（如禁止读 `.env`）**：会改变现有用户的行为，先不带。

## 测试（TDD）

- **规则解析**：三种写法合法；括号不配对、未知工具、不支持的括号、空对象各自无效并给出原因。
- **命令匹配**：完全相同、结尾 `*`、贴着的 `*`、段首环境变量赋值；复合命令下 allow 要求全中、deny 一段即中；不安全结构不匹配 allow。
- **路径匹配**：文件名模式匹配任意深度；`*` 与 `**`；`~/`、`/`、`**/` 开头；`目录/**` 匹配目录本身；`..` 归一化；macOS 上不分大小写。
- **deny 路径规则与 bash**：`cat .env`、`grep x config/.env`、带括号的参数被拒；`-` 开头的参数不参与；`secrets/**` 拦住以其下路径为参数的命令。
- **判定顺序**：表驱动，覆盖六步之间的高低关系（模式高于 allow、deny 高于 ask、ask 拦住只读命令、配置 ask 高于本会话 allow、`auto` 下 deny 和 ask 仍然生效）。
- **归纳**：上表每一行，外加三个"记原文"的条件（含 `bun -e`、`bun x`、`npm exec`、`node -e`）和 `bun test` 这类应当归纳的边界用例。
- **循环**：规则放行时不调用 `requestPermission`；规则拒绝时给模型说明；ask 规则让只读命令也询问；只读模式下 allow 规则不能放行变更。
- **REPL**：三行提示；按 `a` 后同类调用不再提示；ask 规则触发的提示没有 `a` 行；`(allowed: …)` 标记；`/permissions` 与 `/permissions clear`。
- **ACP**：选项是三个；`allow_always` 之后同类调用不再发请求；`reject_always` 之后同类调用直接拒绝；`allow_once` 行为不变。

## 文档同步

- `README.md`：新增"权限规则"一节（配置示例、三种对象、判定顺序、归纳表、"尽力而为"的说明），命令表加 `/permissions`，工具表的授权一列提到规则。
- `docs/ACP.md`：权限流程的选项与回答更新。
- `docs/roadmap.md`：发版后把阶段一第 1 项划掉。
