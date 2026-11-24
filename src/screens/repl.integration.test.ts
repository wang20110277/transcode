import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { AIMessageChunk } from '@langchain/core/messages';

/**
 * REPL-level integration test: a scripted model streams a final text answer
 * after tool calls; the landed static entry MUST contain that reply text.
 * This is the seam where "reply vanished from the landed entry" lived.
 */

const textEvents: string[] = [];
let real: typeof import('../provider/provider.js');

beforeAll(async () => {
  // Override ONLY createModel; re-export the real module for everything else.
  // A COPY of the exports: mock.module replaces a loaded module's exports in
  // place, so the namespace object itself would turn into the mock.
  real = { ...(await import('../provider/provider.js')) };
  let call = 0;
  const scriptedModel = {
    config: { name: 'Stub Model' },
    model: {
      bindTools: () => ({
        async stream() {
          call++;
          // Exact user shape: round 1 = intro text + two tool calls,
          // round 2 = final answer text after the last tool result.
          const rounds = [
            [
              new AIMessageChunk({ content: '我来看一下项目结构和关键文件。' }),
              new AIMessageChunk({
                content: '',
                tool_call_chunks: [
                  { id: 'c1', name: 'glob', args: '{"pattern":"**/*"}', index: 0 },
                  { id: 'c2', name: 'read_file', args: '{"path":"package.json"}', index: 1 },
                ],
              }),
            ],
            [new AIMessageChunk({ content: '这个项目用 Vite + React,是一个示例应用。' })],
          ];
          const chunks = rounds[Math.min(call, 2) - 1]!;
          return (async function* () {
            for (const chunk of chunks) yield chunk;
          })();
        },
      }),
    },
  };
  mock.module('../provider/provider.js', () => ({
    ...real,
    createModel: () => scriptedModel,
  }));
});

// mock.module is process-wide and neither mock.restore() nor a later bun
// file boundary undoes it, and bun runs test files in sorted order: put the
// real exports back, or every later file gets the scripted model.
afterAll(() => {
  mock.module('../provider/provider.js', () => real);
});

function pressEnter(instance: ReturnType<typeof render>, text: string): void {
  // Type each character, then a carriage return (raw-mode Enter).
  for (const ch of text) instance.stdin.write(ch);
  instance.stdin.write('\r');
}

describe('REPL turn landing (static architecture)', () => {
  test('回复文本必须出现在落地条目中', async () => {
    process.env.TRANSCODE_CONFIG_PATH = '/tmp/transcode-repl-it-config.json';
    const { writeFileSync, rmSync } = await import('node:fs');
    writeFileSync('/tmp/transcode-repl-it-config.json', '{}');
    const { default: REPL } = await import('./REPL.js');
    const instance = render(
      React.createElement(REPL, {
        ctx: { modelId: 'stub', setModelId: () => {}, clearHistory: () => {} },
        banner: { logo: 'LOGO', model: 'stub', dir: '/tmp' },
      }),
    );
    try {
      pressEnter(instance, '帮我看下框架');
      // Let the turn run to completion (scripted model is instant; the
      // throttle/land pipeline needs a few macrotasks).
      await new Promise((resolve) => setTimeout(resolve, 300));

      const frame = instance.lastFrame();
      textEvents.push(frame ?? '');
      expect(frame).toContain('帮我看下框架');
      // THE assertion that failed in production: the model's reply text
      // must survive into the landed entry.
      expect(frame).toContain('Vite + React,是一个示例应用。');
      expect(frame).toContain('我来看一下项目结构和关键文件。');
    } finally {
      instance.unmount();
      rmSync('/tmp/transcode-repl-it-config.json', { force: true });
      delete process.env.TRANSCODE_CONFIG_PATH;
    }
  });
});
