import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { resetPermissionMode, setPermissionMode } from './agent/permission.js';

/**
 * Plan mode across both surfaces (REPL and ACP). A scripted model replaces
 * createModel for the whole file: mock.module is process-wide, so everything
 * that needs it lives here and the real exports go back afterwards.
 *
 * The script records what the model is handed — the system prompt, the last
 * user text, the tool results — so the tests assert on what the model really
 * receives. A refused tool's reason never reaches the screen, for one.
 */

/** What one model call was handed. */
type Seen = { system: string; user: string; tools: string[] };

const seen: Seen[] = [];
let calls = 0;

const scriptedModel = {
  config: { name: 'Scripted Model' },
  model: {
    bindTools: () => ({
      async stream(messages: BaseMessage[]) {
        calls++;
        const last = (type: string): string => {
          const matches = messages.filter(message => message.getType() === type);
          return String(matches.at(-1)?.content ?? '');
        };
        const user = last('human');
        seen.push({
          system: last('system'),
          user,
          tools: messages.filter(message => message.getType() === 'tool').map(message => String(message.content)),
        });
        let chunk: AIMessageChunk;
        if (user.includes('SCRIPT_MUTATE') && calls === 1) {
          // A write the session has no business performing in plan mode.
          chunk = new AIMessageChunk({
            content: '',
            tool_call_chunks: [{ id: 'w1', name: 'write_file', args: '{"path":"plan-probe.txt","content":"probe"}', index: 0 }],
          });
        } else if (user.includes('SCRIPT_READY')) {
          chunk = new AIMessageChunk({ content: '1. 改 A\n2. 改 B\nPLAN READY' });
        } else {
          chunk = new AIMessageChunk({ content: `scripted reply to: ${user}` });
        }
        return (async function* () {
          yield chunk;
        })();
      },
    }),
  },
};

let real: typeof import('./provider/provider.js');

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

/**
 * Credential and gateway variables inherited from the developer's shell.
 * They must not leak into these tests: the scripted model never calls out,
 * but nothing here should ever be able to reach a real endpoint either.
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
let savedEnv: Record<string, string | undefined> = {};
let root: string;
const mounted: ReturnType<typeof render>[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const name of ISOLATED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  root = mkdtempSync(path.join(tmpdir(), 'transcode-plan-mode-'));
  writeFileSync(path.join(root, 'config.json'), '{}');
  process.env.TRANSCODE_CONFIG_PATH = path.join(root, 'config.json');
  process.env.TRANSCODE_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.TRANSCODE_USER_DIR = path.join(root, 'user');
  process.env.TRANSCODE_PERMISSION_MODE = 'ask';
  resetPermissionMode();
  seen.length = 0;
  calls = 0;
});

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  for (const name of DIR_OVERRIDES) delete process.env[name];
  if (savedEnv['TRANSCODE_PERMISSION_MODE'] === undefined) delete process.env.TRANSCODE_PERMISSION_MODE;
  else process.env.TRANSCODE_PERMISSION_MODE = savedEnv['TRANSCODE_PERMISSION_MODE'];
  for (const name of ISOLATED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name]!;
  }
  resetPermissionMode();
  rmSync(root, { recursive: true, force: true });
});

const settle = (ms = 100): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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
      ctx: { modelId: 'stub', setModelId: () => {} },
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

describe('plan mode in the REPL', () => {
  test('the PLAN MODE instruction follows the mode, and plan turns print no banner', async () => {
    setPermissionMode('plan');
    const planning = await mount();
    await submit(planning, 'look around');
    await until(() => frame(planning).includes('scripted reply'));
    // The indicator already says "plan"; a banner on every turn would be noise.
    expect(frame(planning)).not.toContain('［plan 模式');

    // The mode is process-wide: switch it back for the contrasting turn.
    setPermissionMode('ask');
    const asking = await mount();
    await submit(asking, 'look around');
    await until(() => frame(asking).includes('scripted reply'));

    expect(seen.map(call => call.system.includes('PLAN MODE'))).toEqual([true, false]);
    // Exactly once: the turn's prompt is built in one place and handed to the loop as is.
    expect(seen[0]!.system.match(/PLAN MODE/g)).toHaveLength(1);
  });

  test('a mutating tool call is refused with the plan guidance', async () => {
    setPermissionMode('plan');
    const instance = await mount();
    await submit(instance, 'SCRIPT_MUTATE');
    await until(() => frame(instance).includes('scripted reply'));

    expect(seen.at(-1)?.tools.join('\n')).toContain('Plan mode is read-only');
    expect(existsSync(path.join(process.cwd(), 'plan-probe.txt'))).toBe(false);
  });

  test('a finished plan ends with a hint to switch mode; an ordinary reply does not', async () => {
    setPermissionMode('plan');
    const planning = await mount();
    await submit(planning, 'SCRIPT_READY');
    await until(() => frame(planning).includes('PLAN READY'));
    await settle(300);
    expect(frame(planning)).toContain('方案已就绪');

    setPermissionMode('ask');
    const asking = await mount();
    await submit(asking, 'SCRIPT_READY');
    await until(() => frame(asking).includes('PLAN READY'));
    await settle(300);
    expect(frame(asking)).not.toContain('方案已就绪');
  });

  test('/plan is gone: it is reported as an unknown command and never starts a plan turn', async () => {
    const instance = await mount();
    await submit(instance, '/plan fix the bug');
    await until(() => frame(instance).includes('Unknown command: plan'));

    expect(seen).toEqual([]); // the model was never asked
    expect(frame(instance)).not.toContain('［plan 模式');
  });
});

describe('plan mode over ACP', () => {
  test('TRANSCODE_PERMISSION_MODE=plan refuses mutations itself and never asks the host', async () => {
    process.env.TRANSCODE_PERMISSION_MODE = 'plan';
    resetPermissionMode();
    const { AcpSession } = await import('./acp/session.js');
    const permissionRequests: unknown[] = [];
    const session = new AcpSession(
      {
        sendUpdate: () => {},
        requestPermission: async request => {
          permissionRequests.push(request);
          return { outcome: { outcome: 'cancelled' as const } };
        },
      },
      root,
    );

    const result = await session.prompt({
      sessionId: session.id,
      prompt: [{ type: 'text', text: 'SCRIPT_MUTATE' }],
    });

    expect(seen.at(-1)?.system).toContain('PLAN MODE');
    expect(seen.at(-1)?.tools.join('\n')).toContain('Plan mode is read-only');
    expect(permissionRequests).toEqual([]);
    expect(existsSync(path.join(root, 'plan-probe.txt'))).toBe(false);
    expect(result.stopReason).toBe('end_turn');
  });
});
