import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import {
  clearRegisteredApiKeys,
  registerApiKey,
  resolveModel,
  saveCustomProfile,
  setCustomModel,
} from '../provider/provider.js';
import REPL from './REPL.js';

/**
 * The custom-gateway flow of /models, against a gateway routed like NewAPI:
 * the API lives under /v1 and every other path answers 200 with the web page.
 * Saved gateways are listed with their address; a new one is saved only once
 * its connectivity check passes.
 */

let configDir: string;
let configPath: string;
const servers: ReturnType<typeof Bun.serve>[] = [];
const mounted: ReturnType<typeof render>[] = [];

/**
 * Credential and gateway variables inherited from the developer's shell
 * (e.g. Claude Code's). They must not leak into this test: a mis-navigated
 * keystroke that reaches the chat path would then make a REAL model request.
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
let savedEnv: Record<string, string | undefined> = {};

const WEB_PAGE = '<!doctype html><html><body><div id="root"></div></body></html>';
const COMPLETION = {
  id: 'c1',
  object: 'chat.completion',
  model: 'qwen3.6-35b-fp8',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

beforeEach(() => {
  savedEnv = {};
  for (const name of ISOLATED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-custom-flow-test-'));
  configPath = path.join(configDir, 'config.json');
  process.env.TRANSCODE_CONFIG_PATH = configPath;
  delete process.env.TRANSCODE_BASE_URL;
  delete process.env.TRANSCODE_PERMISSION_MODE;
  clearRegisteredApiKeys();
  servers.length = 0;
});
afterEach(async () => {
  for (const instance of mounted.splice(0)) instance.unmount();
  delete process.env.TRANSCODE_CONFIG_PATH;
  delete process.env.TRANSCODE_BASE_URL;
  for (const name of ISOLATED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(configDir, { recursive: true, force: true });
  for (const gateway of servers) await gateway.stop?.();
  servers.length = 0;
});

/** Starts a NewAPI-like gateway and returns its root URL (no /v1). */
function startGateway(
  options: { chat?: { status: number; body: string; type: string }; models?: string[] } = {},
): string {
  const models = options.models ?? ['qwen3.6-35b-fp8'];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/v1/models') {
        return Response.json({ object: 'list', data: models.map(id => ({ id })) });
      }
      if (pathname === '/v1/chat/completions') {
        if (options.chat) {
          return new Response(options.chat.body, {
            status: options.chat.status,
            headers: { 'content-type': options.chat.type },
          });
        }
        return Response.json(COMPLETION);
      }
      // Unknown paths: NewAPI answers with 200 + the web page.
      return new Response(WEB_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port!}`;
}

/** ink-testing-library returns raw ANSI; strip SGR so coloured spans compare as text. */
const plain = (frame: string): string => frame.replace(/\x1b\[[0-9;]*m/g, '');
/** Key handlers are re-bound one render behind the frame: let it land before the next key. */
const settle = (ms = 150): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type Instance = ReturnType<typeof render>;

function mount(setModelId: (id: string) => void = () => {}): Instance {
  const instance = render(
    React.createElement(REPL, {
      ctx: { modelId: 'stub', setModelId, clearHistory: () => {} },
      banner: { logo: 'LOGO', model: 'stub', dir: '/tmp' },
    }),
  );
  mounted.push(instance);
  return instance;
}

async function press(instance: Instance, key: string): Promise<void> {
  instance.stdin.write(key);
  await settle();
}

/** Types text, waits for the handlers to see it, then presses Enter and waits again. */
async function submit(instance: Instance, text: string): Promise<void> {
  for (const ch of text) instance.stdin.write(ch);
  // A burst-typed "/models" + Enter would hit the slash popup's completion
  // branch (its candidates lag one keystroke) instead of submitting.
  await settle(30);
  await press(instance, '\r');
}

/** /models → the custom vendor (last row: Up wraps from the first) → its gateway list. */
async function openCustomGateways(instance: Instance): Promise<void> {
  await submit(instance, '/models');
  await press(instance, '\x1b[A');
  await press(instance, '\r');
}

describe('custom gateways in /models', () => {
  test('a gateway typed with a root address lists its live models and is saved with the versioned path', async () => {
    const root = startGateway();
    const instance = mount();
    await settle();

    await openCustomGateways(instance);
    await press(instance, '\r'); // nothing saved yet: the list only offers "+ 新建自定义模型…"
    await submit(instance, root); // BASE_URL, typed the way Claude Code is configured
    await submit(instance, 'k'); // API key
    await settle();

    const frame = plain(instance.lastFrame() ?? '');
    expect(frame).toContain('qwen3.6-35b-fp8');
    expect(frame).toContain('网关实时列表');

    await press(instance, '\r'); // Enter on the live-list entry: verify, then budget picker
    await settle();
    expect(plain(instance.lastFrame() ?? '')).toContain('上下文预算');

    await press(instance, '\r'); // default budget → the switch is applied and the entry saved
    expect(resolveModel('qwen3.6-35b-fp8').baseUrl).toBe(`${root}/v1`);
  });

  test('a saved gateway is listed with its address instead of jumping straight to the key prompt', async () => {
    setCustomModel({ baseUrl: 'http://10.162.5.19:3000/v1', model: 'qwen3.6-35b-fp8' }); // saved by an older version
    const instance = mount();
    await settle();

    await openCustomGateways(instance);

    const frame = plain(instance.lastFrame() ?? '');
    expect(frame).toContain('qwen3.6-35b-fp8');
    expect(frame).toContain('http://10.162.5.19:3000/v1'); // the address is what was missing
    expect(frame).toContain('新建自定义模型');
    expect(frame).not.toContain('apikey');
  });

  test('a new gateway is saved as its own entry next to the existing one and becomes the active model', async () => {
    const root = startGateway();
    // An entry saved by an older version; 127.0.0.1:1 refuses connections at once.
    setCustomModel({ baseUrl: 'http://127.0.0.1:1/v1', model: 'old-model' });
    const picks: string[] = [];
    const instance = mount(id => picks.push(id));
    await settle();

    await openCustomGateways(instance);
    expect(plain(instance.lastFrame() ?? '')).toContain('http://127.0.0.1:1/v1');
    await press(instance, '\x1b[B'); // down to "+ 新建自定义模型…"
    await press(instance, '\r');
    await submit(instance, root);
    await submit(instance, 'k');
    await settle();
    await press(instance, '\x1b[A'); // wraps from the first model to "自定义模型名…"
    await press(instance, '\r');
    await submit(instance, 'qwen3.6-35b-fp8'); // model name → connectivity check
    await settle();

    expect(plain(instance.lastFrame() ?? '')).toContain('上下文预算');
    expect(resolveModel('custom').baseUrl).toBe('http://127.0.0.1:1/v1'); // the older entry is untouched

    await press(instance, '\r'); // default budget → the switch is applied
    expect(picks.at(-1)).toBe('qwen3.6-35b-fp8');
    expect(resolveModel('qwen3.6-35b-fp8').baseUrl).toBe(`${root}/v1`); // saved on its own
  });

  test('a gateway that fails its connectivity check is not saved', async () => {
    const root = startGateway({ chat: { status: 401, body: '{"error":{"message":"bad key"}}', type: 'application/json' } });
    setCustomModel({ baseUrl: 'http://127.0.0.1:1/v1', model: 'old-model' });
    const instance = mount();
    await settle();

    await openCustomGateways(instance);
    await press(instance, '\x1b[B');
    await press(instance, '\r');
    await submit(instance, root);
    await submit(instance, 'k');
    await settle();
    await press(instance, '\x1b[A');
    await press(instance, '\r');
    await submit(instance, 'qwen3.6-35b-fp8');
    await settle();

    expect(plain(instance.lastFrame() ?? '')).toContain('连通失败');
    expect(loadConfig().profiles).toBeUndefined();
    expect(resolveModel('custom').baseUrl).toBe('http://127.0.0.1:1/v1');
  });

  test('a saved entry is switched to from the list, reusing its saved key', async () => {
    const root = startGateway();
    const name = saveCustomProfile({ baseUrl: `${root}/v1`, model: 'qwen3.6-35b-fp8' });
    registerApiKey(name, 'k');
    const picks: string[] = [];
    const instance = mount(id => picks.push(id));
    await settle();

    await openCustomGateways(instance);
    await press(instance, '\r'); // the saved entry → its key prompt
    expect(plain(instance.lastFrame() ?? '')).toContain('回车沿用'); // the saved key is offered

    await press(instance, '\r'); // reuse it → connectivity check
    await settle();
    expect(plain(instance.lastFrame() ?? '')).toContain('上下文预算');

    await press(instance, '\r'); // default budget → the switch is applied
    expect(picks.at(-1)).toBe('qwen3.6-35b-fp8');
  });

  test('the context budget picked for a new gateway is recorded under that entry, not under the staging name', async () => {
    const root = startGateway();
    const instance = mount();
    await settle();

    await openCustomGateways(instance);
    await press(instance, '\r'); // + 新建自定义模型…
    await submit(instance, root);
    await submit(instance, 'k');
    await settle();
    await press(instance, '\r'); // the live-list entry: verify, then budget picker
    await settle();
    await press(instance, '\x1b[B'); // second choice: 128k
    await press(instance, '\r'); // apply

    const byModel = loadConfig().autoCompact?.byModel ?? {};
    expect(byModel['qwen3.6-35b-fp8']).toBe(128_000);
    expect(byModel['custom']).toBeUndefined(); // "custom" is the legacy entry's budget key
  });

  test('a long model list scrolls with the highlight instead of pushing it off screen', async () => {
    // 150 names without digits, so the picker's ordering is plain alphabetical:
    // model-aa first … model-ft last.
    const many = Array.from({ length: 150 }, (_, i) => {
      const letter = (n: number) => String.fromCharCode(97 + n);
      return `model-${letter(Math.floor(i / 26))}${letter(i % 26)}`;
    });
    const root = startGateway({ models: many });
    const instance = mount();
    await settle();

    await openCustomGateways(instance);
    await press(instance, '\r');
    await submit(instance, root);
    await submit(instance, 'k');
    await settle();

    // The test terminal is 100 rows tall: the whole frame has to fit in it.
    const top = plain(instance.lastFrame() ?? '').trimEnd();
    expect(top.split('\n').length).toBeLessThanOrEqual(100);
    expect(top).toContain('❯ model-aa'); // the highlighted row is on screen…
    expect(top).not.toContain('model-ft'); // …and the far end of the list is scrolled out
    expect(top).toContain('↓ 向下');

    await press(instance, '\x1b[A'); // wraps from the first row to the last: "自定义模型名…"

    const end = plain(instance.lastFrame() ?? '').trimEnd();
    expect(end).toContain('❯ 自定义模型名…');
    expect(end).toContain('model-ft');
    expect(end).not.toContain('❯ model-aa');
    expect(end).toContain('↑ 向上');
  });
});
