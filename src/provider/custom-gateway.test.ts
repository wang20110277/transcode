import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { clearRegisteredApiKeys, resolveGatewayBaseUrl, resolveModel, setCustomModel, verifyModel } from './provider.js';

/**
 * Custom-gateway behaviour against a gateway routed like NewAPI
 * (router/relay-router.go + router/web-router.go): the API lives under /v1
 * and every other path answers 200 with the web page.
 */

let configDir: string;
const servers: ReturnType<typeof Bun.serve>[] = [];
let requests: string[] = [];

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-custom-gateway-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  delete process.env.TRANSCODE_BASE_URL;
  delete process.env.TRANSCODE_API_KEY;
  clearRegisteredApiKeys();
  requests = [];
  servers.length = 0;
});
afterEach(async () => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  delete process.env.TRANSCODE_BASE_URL;
  delete process.env.TRANSCODE_API_KEY;
  rmSync(configDir, { recursive: true, force: true });
  for (const gateway of servers) await gateway.stop?.();
  servers.length = 0;
});

const WEB_PAGE = '<!doctype html><html><body><div id="root"></div></body></html>';

const COMPLETION = {
  id: 'c1',
  object: 'chat.completion',
  model: 'qwen3.6-35b-fp8',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

type GatewayOptions = {
  /** Serve GET /models at the root as well (some gateways mount the API without /v1). */
  rootModels?: boolean;
  /** Serve GET /v1/models (default true). */
  models?: boolean;
  /** What POST /v1/chat/completions answers; default a valid completion. */
  chat?: { status: number; body: string; type: string };
};

/** Starts a NewAPI-like gateway and returns its root URL (no /v1). */
function startGateway(options: GatewayOptions = {}): string {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push(`${request.method} ${pathname}`);
      if (pathname === '/models' && options.rootModels) {
        return Response.json({ object: 'list', data: [{ id: 'qwen3.6-35b-fp8' }] });
      }
      if (pathname === '/v1/models' && options.models !== false) {
        return Response.json({ object: 'list', data: [{ id: 'qwen3.6-35b-fp8' }] });
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

describe('verifyModel against a non-API response', () => {
  test('a web page answered with HTTP 200 is reported as a readable reason, not an internal TypeError', async () => {
    const root = startGateway({ chat: { status: 200, body: WEB_PAGE, type: 'text/html; charset=utf-8' } });
    setCustomModel({ baseUrl: `${root}/v1`, model: 'qwen3.6-35b-fp8' });

    const result = await verifyModel('custom', 'k');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('不是模型响应');
    expect(result.message).not.toMatch(/reading 'message'|not an object/);
  });

  test('suggests the versioned address when the saved one has no version path', async () => {
    const root = startGateway({ models: false });
    setCustomModel({ baseUrl: root, model: 'qwen3.6-35b-fp8' });

    const result = await verifyModel('custom', 'k');

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`${root}/v1`);
  });
});

describe('resolveGatewayBaseUrl', () => {
  test('a root address typed Claude-Code-style resolves to the versioned path the gateway serves', async () => {
    const root = startGateway();

    expect(await resolveGatewayBaseUrl(root, 'k')).toBe(`${root}/v1`);
  });

  test('a trailing slash on a root address resolves the same way', async () => {
    const root = startGateway();

    expect(await resolveGatewayBaseUrl(`${root}/`, 'k')).toBe(`${root}/v1`);
  });

  test('keeps the typed address when it already works as typed', async () => {
    const root = startGateway({ rootModels: true });

    expect(await resolveGatewayBaseUrl(root, 'k')).toBe(root);
  });

  test('does not touch an address that already carries a version path', async () => {
    const root = startGateway();

    expect(await resolveGatewayBaseUrl(`${root}/api/paas/v4`, 'k')).toBe(`${root}/api/paas/v4`);
    expect(requests).toEqual([]);
  });

  test('keeps the typed address when nothing answers', async () => {
    expect(await resolveGatewayBaseUrl('http://127.0.0.1:1/gw', 'k')).toBe('http://127.0.0.1:1/gw');
  });
});

describe('saved custom gateway with a root address', () => {
  test('verification goes through the versioned path and the saved address heals', async () => {
    const root = startGateway();
    setCustomModel({ baseUrl: root, model: 'qwen3.6-35b-fp8' });

    const result = await verifyModel('custom', 'k');

    expect(result.ok).toBe(true);
    expect(result.served).toBe('qwen3.6-35b-fp8');
    expect(resolveModel('custom').baseUrl).toBe(`${root}/v1`);
  });

  test('an explicit TRANSCODE_BASE_URL override is verified against but never written into the saved entry', async () => {
    const saved = startGateway();
    const override = startGateway();
    setCustomModel({ baseUrl: `${saved}/v1`, model: 'qwen3.6-35b-fp8' });
    process.env.TRANSCODE_BASE_URL = override; // root address, NewAPI-style

    const result = await verifyModel('custom', 'k');

    // The override's own (root) address is what got tested, so it fails…
    expect(result.ok).toBe(false);
    // …and the address resolved from the override must not leak into the entry.
    expect(resolveModel('custom').baseUrl).toBe(`${saved}/v1`);
  });
});

describe('custom gateway still being set up (not saved yet)', () => {
  const savedBefore = { baseUrl: 'https://legacy.example/v1', model: 'old-model' };

  test('is verified against the given address without writing anything to the config', async () => {
    const staging = startGateway();
    setCustomModel(savedBefore); // an older entry must survive the new setup

    const result = await verifyModel('custom', 'k', { baseUrl: staging, model: 'qwen3.6-35b-fp8' });

    expect(result.ok).toBe(true);
    expect(result.served).toBe('qwen3.6-35b-fp8');
    expect(result.baseUrl).toBe(`${staging}/v1`); // the path that was actually verified
    expect(loadConfig().custom).toEqual(savedBefore);
    expect(loadConfig().profiles).toBeUndefined();
  });

  test('a failed verification leaves the config untouched', async () => {
    const staging = startGateway({ chat: { status: 401, body: '{"error":{"message":"bad key"}}', type: 'application/json' } });
    setCustomModel(savedBefore);

    const result = await verifyModel('custom', 'k', { baseUrl: `${staging}/v1`, model: 'qwen3.6-35b-fp8' });

    expect(result.ok).toBe(false);
    expect(loadConfig().custom).toEqual(savedBefore);
    expect(loadConfig().profiles).toBeUndefined();
  });
});
