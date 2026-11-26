import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';

/**
 * A test that mounts the REPL and waits for real turns. bun stops a test
 * after 5s by default; while the whole suite runs in parallel a turn can
 * take ten times longer than alone (2026-11-26: one that takes 0.45s alone
 * passed 4.5s under full load), so these get more room than that.
 */
const TURN_TEST_TIMEOUT_MS = 20_000;
const turnTest = (name: string, run: () => Promise<void>) => test(name, run, TURN_TEST_TIMEOUT_MS);

/**
 * The ctrl+o panel in the REPL. Printed history never changes, so the detail
 * of a folded turn is shown in the live region, where it can open and close.
 * A scripted model replaces createModel for the whole file: mock.module is
 * process-wide, so everything that needs it lives here and the real exports
 * go back afterwards.
 */

/** ctrl+o, as Ink hands it to the key handler (ctrl + the letter o). */
const CTRL_O = '\x0f';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ESC = '\x1b';
const PANEL_TITLE = '展开明细 · ';

/**
 * FOLD_A and FOLD_B each read four files — enough tool calls for the turn
 * to be folded. The two turns read different files, so the panel can be
 * checked on the turn it shows. Reading files needs no shell and no
 * permission, which keeps this file quick and quiet next to the others.
 */
const FOLD_FILES: Record<string, string[]> = {
  FOLD_A: ['package.json', 'tsconfig.json', '.npmrc', 'bin/transcode.ts'],
  FOLD_B: ['README.md', 'docs/roadmap.md', 'docs/ACP.md', 'src/version.ts'],
};
const readsOf = (keyword: string): string[] => FOLD_FILES[keyword]!.map((file) => `read: ${file}`);
const scriptedModel = {
  config: { name: 'Scripted Model' },
  model: {
    bindTools: () => ({
      async stream(messages: BaseMessage[]) {
        const lastHuman = messages.findLastIndex((message) => message.getType() === 'human');
        const step = messages.slice(lastHuman + 1).filter((message) => message.getType() === 'tool').length;
        const user = String(messages[lastHuman]?.content ?? '');
        const keyword = Object.keys(FOLD_FILES).find((name) => user.includes(name));

        const chunk =
          keyword && step < FOLD_FILES[keyword]!.length
            ? new AIMessageChunk({
                content: '',
                tool_call_chunks: [
                  {
                    id: `${keyword}${step}`,
                    name: 'read_file',
                    args: JSON.stringify({ path: FOLD_FILES[keyword]![step] }),
                    index: 0,
                  },
                ],
              })
            : new AIMessageChunk({ content: `reply ${user}` });
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
  root = mkdtempSync(path.join(tmpdir(), 'transcode-expansion-panel-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(root, 'config.json');
  writeFileSync(process.env.TRANSCODE_CONFIG_PATH, '{}');
  process.env.TRANSCODE_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.TRANSCODE_USER_DIR = path.join(root, 'user');
  delete process.env.TRANSCODE_PERMISSION_MODE;
});

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  for (const name of DIR_OVERRIDES) delete process.env[name];
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

async function mount(): Promise<ReturnType<typeof render>> {
  const { default: REPL } = await import('./REPL.js');
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

/** One key, then a frame: handlers see state one render late. */
async function press(instance: ReturnType<typeof render>, key: string): Promise<void> {
  instance.stdin.write(key);
  await settle(150);
}

/** Runs one turn to the end and lets it land in the printed history. */
async function runTurn(instance: ReturnType<typeof render>, text: string): Promise<void> {
  await submit(instance, text);
  await until(() => frame(instance).includes(`reply ${text}`));
  await settle(300);
}

const openPanel = async (instance: ReturnType<typeof render>): Promise<void> => {
  await press(instance, CTRL_O);
  await until(() => frame(instance).includes(PANEL_TITLE));
};

describe('the ctrl+o detail panel', () => {
  turnTest('opens the latest folded turn and closes on the next press, adding nothing to the transcript', async () => {
    const instance = await mount();
    await runTurn(instance, 'FOLD_A');
    const closed = frame(instance);
    expect(closed).toContain('… +4 lines (ctrl+o 展开明细)');

    await openPanel(instance);
    const open = frame(instance);
    expect(open).toContain('⚙ 展开明细 · 最近一个折叠回合');
    expect(open).toContain('ctrl+o 收起 · ↑↓ 切换回合');
    for (const line of readsOf('FOLD_A')) expect(open).toContain(line);

    await press(instance, CTRL_O);
    // The transcript is exactly what it was: nothing was printed, only shown.
    expect(frame(instance)).toBe(closed);
  });

  turnTest('the same folded turn can be opened again and again', async () => {
    const instance = await mount();
    await runTurn(instance, 'FOLD_A');
    for (let i = 0; i < 2; i++) {
      await openPanel(instance);
      expect(frame(instance)).toContain('read: package.json');
      await press(instance, CTRL_O);
      await until(() => !frame(instance).includes(PANEL_TITLE));
    }
  });

  turnTest('the arrows move between folded turns and stop at the ends', async () => {
    const instance = await mount();
    await runTurn(instance, 'FOLD_A');
    await runTurn(instance, 'FOLD_B');

    await openPanel(instance);
    expect(frame(instance)).toContain('最近一个折叠回合');
    for (const line of readsOf('FOLD_B')) expect(frame(instance)).toContain(line);
    for (const line of readsOf('FOLD_A')) expect(frame(instance)).not.toContain(line);

    await press(instance, UP); // the older folded turn
    expect(frame(instance)).toContain('倒数第 2 个折叠回合（共 2 个）');
    for (const line of readsOf('FOLD_A')) expect(frame(instance)).toContain(line);
    for (const line of readsOf('FOLD_B')) expect(frame(instance)).not.toContain(line);

    await press(instance, UP); // already the oldest: stays there
    expect(frame(instance)).toContain('倒数第 2 个折叠回合（共 2 个）');

    await press(instance, DOWN); // back to the newest
    expect(frame(instance)).toContain('最近一个折叠回合');
    for (const line of readsOf('FOLD_B')) expect(frame(instance)).toContain(line);
  });

  turnTest('Esc closes the panel instead of leaving the app', async () => {
    const instance = await mount();
    await runTurn(instance, 'FOLD_A');
    await openPanel(instance);

    await press(instance, ESC);
    await until(() => !frame(instance).includes(PANEL_TITLE));
    expect(frame(instance)).toContain('mode: ask'); // still at the prompt
  });

  turnTest('a new turn closes the panel', async () => {
    const instance = await mount();
    await runTurn(instance, 'FOLD_A');
    await openPanel(instance);

    await runTurn(instance, 'plain question');
    expect(frame(instance)).not.toContain(PANEL_TITLE);
  });

  turnTest('/clear closes the panel', async () => {
    const instance = await mount();
    await runTurn(instance, 'FOLD_A');
    await openPanel(instance);

    await submit(instance, '/clear');
    await until(() => frame(instance).includes('\x1b[2J'));
    await settle(300);
    expect(frame(instance)).not.toContain(PANEL_TITLE);
  });

  turnTest('with nothing folded, ctrl+o says so, and the next key dismisses it and keeps its meaning', async () => {
    const instance = await mount();
    await press(instance, CTRL_O);
    await until(() => frame(instance).includes('没有折叠的回合。'));

    await press(instance, 'x'); // typed straight into the prompt
    const after = frame(instance);
    expect(after).not.toContain('没有折叠的回合。');
    expect(after).toContain('> x▎');
  });
});
