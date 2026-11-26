import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import React from 'react';
import { render } from 'ink-testing-library';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { AcpSession } from './acp/session.js';
import type { AcpPermissionRequest } from './acp/protocol.js';

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
const mounted: ReturnType<typeof render>[] = [];

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
  for (const instance of mounted.splice(0)) instance.unmount();
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
  test('a key that arrives the moment the question appears is handled by the new state, not the one before it', async () => {
    const instance = await mount();
    // Ink binds the key handler in an effect, which React runs only after
    // the frame is drawn. Press the key inside the frame's own write, where
    // no effect can have run yet: what a fast hand or a paste looks like,
    // and what happens routinely when the machine is under load.
    const write = instance.stdout.write.bind(instance.stdout);
    let pressed = false;
    instance.stdout.write = ((chunk: string) => {
      write(chunk);
      if (!pressed && chunk.includes('allow?')) {
        pressed = true;
        instance.stdin.write('a');
      }
    }) as typeof instance.stdout.write;
    await submit(instance, 'SCRIPT_SAVE');
    await until(() => frame(instance).includes('scripted reply'));

    expect(pressed).toBe(true);
    expect(getSessionRules().map((rule) => rule.text)).toEqual(['memory_save']);
  }, 20_000);

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
    expect(frame(instance)).toContain('已清空本会话记下的 1 条规则。');
    expect(getSessionRules()).toEqual([]);

    await submit(instance, '/permissions clear');
    await until(() => frame(instance).includes('本会话没有记下任何规则。'));
    expect(frame(instance)).toContain('本会话没有记下任何规则。');
  });
});
