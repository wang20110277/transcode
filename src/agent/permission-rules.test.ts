import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  PATH_TOOLS,
  PLAN_DENIAL,
  READONLY_DENIAL,
  alwaysRule,
  clearSessionRules,
  commandAllowed,
  deniedPathInCommand,
  evaluatePermission,
  getSessionRules,
  invalidRulesNotice,
  invalidRulesWarning,
  loadPermissionRules,
  parsePermissionRules,
  pathMatches,
  rememberAlways,
  renderPermissionRules,
  ruleMatches,
  type PermissionCall,
  type PermissionRule,
  type PermissionRuleSet,
  type RuleEffect,
} from './permission-rules.js';

/** Every registered tool, as the loop and the commands see them. */
const TOOLS = [
  'bash', 'bash_output', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'todo_write',
  'ask_model', 'dispatch_agent', 'memory_save', 'memory_delete', 'web_fetch', 'web_search',
];

/** Parses one rule, failing the test if it does not parse. */
const rule = (text: string, effect: RuleEffect = 'allow'): PermissionRule => {
  const parsed = parsePermissionRules({ permissions: { [effect]: [text] } }, TOOLS);
  expect(parsed.invalid).toEqual([]);
  return parsed.rules[0]!;
};
const bashCall = (command: string): PermissionCall => ({ name: 'bash', input: { command }, cwd: '/work' });

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
    expect(evaluatePermission(run, 'ask', none, [])).toEqual({ action: 'ask', alwaysRule: 'bash(npm test*)' });
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
