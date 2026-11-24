import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearRegisteredApiKeys, registerApiKey, setCustomModel } from '../provider/provider.js';
import REPL from './REPL.js';

/**
 * A turn streamed from a gateway that reports usage on EVERY chunk (running
 * totals). LangChain warns three times per chunk while accumulating them;
 * inside the REPL those lines would land straight in the terminal.
 */

const NOISE = 'already exists in this message chunk and value has unsupported type';
const REPLY = ['Hi', '!', ' 👋', ' How', ' can', ' I', ' help', '?'];

let configDir: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let savedEnv: Record<string, string | undefined> = {};

/**
 * Credential and gateway variables inherited from the developer's shell
 * (e.g. Claude Code's): without them a stray chat request cannot go anywhere.
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

function startGateway(): string {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [{ id: 'm' }] });
      }
      const promptTokens = 21;
      const frames = REPLY.map((text, i) => {
        const completion = i + 1;
        return `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          model: 'm',
          choices: [{ index: 0, delta: { content: text }, finish_reason: i === REPLY.length - 1 ? 'stop' : null }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completion,
            total_tokens: promptTokens + completion,
            completion_tokens_details: { reasoning_tokens: completion },
          },
        })}\n\n`;
      });
      return new Response([...frames, 'data: [DONE]\n\n'].join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  return `http://127.0.0.1:${server.port!}/v1`;
}

const plain = (frame: string): string => frame.replace(/\x1b\[[0-9;]*m/g, '');
const settle = (ms = 150): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(instance: ReturnType<typeof render>, text: string, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (plain(instance.lastFrame() ?? '').includes(text)) return true;
    await settle(100);
  }
  return plain(instance.lastFrame() ?? '').includes(text);
}

beforeEach(() => {
  savedEnv = {};
  for (const name of ISOLATED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-stream-noise-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  delete process.env.TRANSCODE_BASE_URL;
  delete process.env.TRANSCODE_PERMISSION_MODE;
  clearRegisteredApiKeys();
});
afterEach(async () => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  delete process.env.TRANSCODE_BASE_URL;
  for (const name of ISOLATED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(configDir, { recursive: true, force: true });
  await server?.stop?.();
  server = undefined;
});

describe('streaming in the REPL', () => {
  test('a gateway reporting usage on every chunk does not flood the terminal with chunk-merge warnings', async () => {
    const root = startGateway();
    setCustomModel({ baseUrl: root, model: 'm' });
    registerApiKey('custom', 'k');
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    const instance = render(
      React.createElement(REPL, {
        ctx: { modelId: 'custom', setModelId: () => {}, clearHistory: () => {} },
        banner: { logo: 'LOGO', model: 'stub', dir: '/tmp' },
      }),
    );
    try {
      await settle();
      for (const ch of 'hi') instance.stdin.write(ch);
      await settle(30);
      instance.stdin.write('\r');

      expect(await waitFor(instance, REPLY.join(''), 8000)).toBe(true); // the turn really streamed

      // The warning is triggered by this stream (it shows up here the moment
      // the REPL stops filtering); none of it may reach the console.
      expect(warnings.filter(line => line.includes(NOISE))).toEqual([]);
    } finally {
      instance.unmount();
      console.warn = original;
    }
  });
});
