import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { registerApiKey, saveCustomProfile } from '../provider/provider.js';

/**
 * A test that mounts the REPL and waits for real turns. bun stops a test
 * after 5s by default; while the whole suite runs in parallel a turn can
 * take ten times longer than alone (2026-11-26: one that takes 0.45s alone
 * passed 4.5s under full load), so these get more room than that.
 */
const TURN_TEST_TIMEOUT_MS = 20_000;
const turnTest = (name: string, run: () => Promise<void>) => test(name, run, TURN_TEST_TIMEOUT_MS);

/**
 * /clear in the REPL: it starts a new conversation — the model is handed
 * none of the earlier turns — and clears the screen, printing the banner
 * again at the top. A scripted model replaces createModel for the whole
 * file and records what it is handed: mock.module is process-wide, so
 * everything that needs it lives here and the real exports go back
 * afterwards.
 */

/** What one model call was handed, as plain text. */
const seen: string[] = [];

const scriptedModel = {
  config: { name: 'Scripted Model' },
  model: {
    bindTools: () => ({
      async stream(messages: BaseMessage[]) {
        const last = (type: string): string =>
          String(messages.filter((message) => message.getType() === type).at(-1)?.content ?? '');
        seen.push(messages.map((message) => String(message.content)).join('\n'));
        const chunk = new AIMessageChunk({ content: `reply to ${last('human')}` });
        return (async function* () {
          yield chunk;
        })();
      },
    }),
  },
};

let real: typeof import('../provider/provider.js');

beforeAll(async () => {
  // Override ONLY createModel; re-export the real module for everything else
  // (a copy: mock.module replaces a loaded module's exports in place).
  real = { ...(await import('../provider/provider.js')) };
  real.clearRegisteredApiKeys();
  mock.module('../provider/provider.js', () => ({ ...real, createModel: () => scriptedModel }));
});

// mock.module is neither undone by a file boundary nor by mock.restore():
// put the real exports back, or every later file gets the scripted model.
afterAll(() => {
  mock.module('../provider/provider.js', () => real);
});

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
let savedEnv: Record<string, string | undefined> = {};
let root: string;
const mounted: ReturnType<typeof render>[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const name of ISOLATED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  root = mkdtempSync(path.join(tmpdir(), 'transcode-clear-command-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(root, 'config.json');
  writeFileSync(process.env.TRANSCODE_CONFIG_PATH, '{}');
  process.env.TRANSCODE_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.TRANSCODE_USER_DIR = path.join(root, 'user');
  delete process.env.TRANSCODE_PERMISSION_MODE;
  // A model switch through /models: skip its connectivity check (no network in tests).
  process.env.TRANSCODE_SKIP_MODEL_CHECK = '1';
  seen.length = 0;
});

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  for (const name of DIR_OVERRIDES) delete process.env[name];
  delete process.env.TRANSCODE_SKIP_MODEL_CHECK;
  for (const name of ISOLATED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(root, { recursive: true, force: true });
});

const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the condition holds; a timeout lets the caller's assertion report the stale frame. */
async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await settle(40);
  }
}

/** ink-testing-library returns raw ANSI; strip SGR so coloured spans compare as text. */
const frame = (instance: ReturnType<typeof render>): string =>
  (instance.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** Everything written to the terminal from `from` on. */
const writtenSince = (instance: ReturnType<typeof render>, from: number): string[] =>
  instance.stdout.frames.slice(from);

type Instance = ReturnType<typeof render>;

/** What the app hands the REPL: the model in use, in the context and in the banner. */
function propsFor(modelId: string, setModelId: (id: string) => void) {
  return {
    ctx: { modelId, setModelId },
    banner: { logo: 'LOGO', model: modelId, dir: '/tmp' },
  };
}

/**
 * Mounts the REPL the way the app does — including what happens on a model
 * switch: the app re-renders with the new model in the context and in the
 * banner.
 */
async function mount(): Promise<Instance> {
  const { default: REPL } = await import('./REPL.js');
  let current = 'stub';
  let instance!: Instance;
  const setModelId = (id: string) => {
    current = id;
    instance.rerender(React.createElement(REPL, propsFor(current, setModelId)));
  };
  instance = render(React.createElement(REPL, propsFor(current, setModelId)));
  mounted.push(instance);
  await settle();
  return instance;
}

/** Types text, lets the handlers see it, then presses Enter (a burst would hit the slash popup). */
async function submit(instance: Instance, text: string): Promise<void> {
  for (const ch of text) instance.stdin.write(ch);
  await settle(40);
  instance.stdin.write('\r');
}

/** One key, then a frame: handlers see state one render late. */
async function pressKey(instance: Instance, key: string): Promise<void> {
  instance.stdin.write(key);
  await settle(150);
}

/** Runs one turn to the end and lets it land in the printed history. */
async function runTurn(instance: Instance, text: string): Promise<void> {
  await submit(instance, text);
  await until(() => frame(instance).includes(`reply to ${text}`));
  await settle(300);
}

/**
 * Switches to the saved gateway `alpha` through /models: the vendor list
 * (the cursor starts on the first vendor) → Up wraps to custom → the entry
 * is under the cursor → Enter opens its key prompt → Enter reuses the saved key.
 */
async function switchToAlpha(instance: Instance): Promise<void> {
  registerApiKey(saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'alpha' }), 'k');
  await submit(instance, '/models');
  await settle(150);
  await pressKey(instance, '\x1b[A');
  await pressKey(instance, '\r');
  await pressKey(instance, '\r');
  await pressKey(instance, '\r');
  await until(() => frame(instance).includes('已切换到 alpha'));
  await settle(300);
}

/** Waits for /clear to have cleared the screen and printed the banner again. */
async function cleared(instance: Instance): Promise<void> {
  await until(() => frame(instance).split('LOGO').length - 1 === 2);
  await settle(200);
}

/** The /clear escape, as written to the terminal: the screen scrolled away, then cleared. */
const CLEAR_WRITE = /^\n+\x1b\[2J\x1b\[H$/;

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('/clear', () => {
  turnTest('clears the screen and prints the banner again at the top', async () => {
    const instance = await mount();
    await runTurn(instance, 'first question');
    const before = instance.stdout.frames.length;
    expect(occurrences(frame(instance), 'LOGO')).toBe(1);

    await submit(instance, '/clear');
    await cleared(instance);

    const written = writtenSince(instance, before);
    expect(written.findIndex((chunk) => CLEAR_WRITE.test(chunk))).toBeGreaterThanOrEqual(0);
    // The banner is printed again, once — and nothing else is said.
    expect(written.some((chunk) => chunk.includes('\x1b[2J') && chunk.includes('LOGO'))).toBe(false);
    expect(occurrences(frame(instance), 'LOGO')).toBe(2);
    expect(frame(instance)).not.toContain('已开始新对话');
  });

  turnTest('clears the screen only: the conversation goes on', async () => {
    const instance = await mount();
    await runTurn(instance, 'first question');
    seen.length = 0;

    await submit(instance, '/clear');
    await cleared(instance);
    await runTurn(instance, 'second question');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('second question');
    expect(seen[0]).toContain('first question');
    expect(seen[0]).toContain('reply to first question');
  });

  turnTest('prints the banner for the model in use, not the one from startup', async () => {
    const instance = await mount();
    await switchToAlpha(instance);
    expect(occurrences(frame(instance), 'Model: alpha')).toBe(1);
    expect(occurrences(frame(instance), 'Model: stub')).toBe(1);

    await submit(instance, '/clear');
    await cleared(instance);

    expect(occurrences(frame(instance), 'Model: alpha')).toBe(2);
    expect(occurrences(frame(instance), 'Model: stub')).toBe(1);
  });

  turnTest('forgets the earlier input when the arrow keys browse back through it', async () => {
    const instance = await mount();
    await runTurn(instance, 'first question');
    await submit(instance, '/clear');
    await cleared(instance);

    await pressKey(instance, '\x1b[A'); // up: the previous input

    expect(frame(instance)).not.toContain('> first question▎');
    expect(frame(instance)).toContain('> ▎');
  });
});

describe('/new', () => {
  turnTest('starts a new conversation without clearing the screen', async () => {
    const instance = await mount();
    await runTurn(instance, 'first question');
    const before = instance.stdout.frames.length;
    seen.length = 0;

    await submit(instance, '/new');
    await until(() => frame(instance).includes('已开始新对话。'));

    expect(writtenSince(instance, before).some((chunk) => chunk.includes('\x1b[2J'))).toBe(false);
    // The old turn was not replaced by a banner: the banner is still printed once.
    expect(occurrences(frame(instance), 'LOGO')).toBe(1);
    expect(seen).toHaveLength(0); // no turn was run by the command

    await runTurn(instance, 'second question');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('second question');
    expect(seen[0]).not.toContain('first question');
  });
});

describe('inputEcho(#4 掩码)', () => {
  test('key 输入相位回显星号,其余原样', async () => {
    const { inputEcho } = await import('./REPL.js');
    expect(inputEcho('search_apikey', 'sk-123')).toBe('******');
    expect(inputEcho('model_apikey', 'sk-123')).toBe('******');
    expect(inputEcho('vendor_apikey', 'sk-123')).toBe('******');
    expect(inputEcho('idle', 'hello')).toBe('hello');
    expect(inputEcho('custom_baseurl', 'http://x')).toBe('http://x');
  });
});
