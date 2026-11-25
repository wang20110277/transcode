/**
 * Permission rules: the `permissions` section of ~/.transcode.json plus the
 * rules a session remembers from "always allow". Everything here is a pure
 * function of its arguments; the only state is the list of session rules.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { parseSegments, type CommandSegment } from './tools/read-only.js';
import { loadConfig } from '../config.js';
import type { PermissionMode } from './permission.js';

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
