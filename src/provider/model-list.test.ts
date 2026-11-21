import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearRegisteredApiKeys, listEndpointModels, registerApiKey } from './provider.js';

let configDir: string;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-modellist-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  clearRegisteredApiKeys();
});
afterEach(async () => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  rmSync(configDir, { recursive: true, force: true });
  await server?.stop?.();
  server = undefined;
});

function stubModelsEndpoint(ids: string[]): string {
  server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }), {
        headers: { 'content-type': 'application/json' },
      }),
  });
  return `http://localhost:${server.port}/v1`;
}

describe('listEndpointModels', () => {
  test('fetches the live model list from the endpoint, newest generation first', async () => {
    const baseUrl = stubModelsEndpoint(['glm-5.1', 'glm-4.6', 'glm-5.3-flash']);
    const { saveConfig } = await import('../config.js');
    saveConfig({
      apiKeys: { custom: 'k' },
      profiles: { myhub: { baseUrl, model: 'glm-4.6', keyId: 'custom' } },
    });

    const models = await listEndpointModels('myhub');
    expect(models).toEqual(['glm-5.3-flash', 'glm-5.1', 'glm-4.6']); // newest first
  });

  test('orders newest generation first: base name before variants, variants before older lines', async () => {
    const baseUrl = stubModelsEndpoint([
      'glm-4.5-air',
      'glm-5.3-flashx-legal',
      'glm-4.6',
      'glm-5.3',
      'glm-5.3-flashx',
      'glm-5.3-flash',
      'glm-5-turbo',
    ]);
    const { saveConfig } = await import('../config.js');
    saveConfig({
      apiKeys: { custom: 'k' },
      profiles: { gen: { baseUrl, model: 'glm-4.6', keyId: 'custom' } },
    });

    const models = await listEndpointModels('gen');
    expect(models).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flashx',
      'glm-5.3-flashx-legal',
      'glm-5-turbo',
      'glm-4.6',
      'glm-4.5-air',
    ]);
  });

  test('override form queries an unsaved custom gateway with its key', async () => {
    const baseUrl = stubModelsEndpoint(['m1', 'm2']);
    const models = await listEndpointModels('', { baseUrl, apiKey: 'k' });
    expect(models).toEqual(['m2', 'm1']); // newest-first heuristic: m2 > m1
  });

  test('returns an empty list on failure so callers can fall back', async () => {
    registerApiKey('deepseek', 'k');
    const models = await listEndpointModels('deepseek'); // real URL, no network in test env → fails fast? may hit network…
    // Use an unreachable local port instead for determinism.
    const { saveConfig } = await import('../config.js');
    saveConfig({
      apiKeys: { custom: 'k' },
      profiles: { dead: { baseUrl: 'http://127.0.0.1:1/v1', model: 'x', keyId: 'custom' } },
    });
    const none = await listEndpointModels('dead');
    expect(none).toEqual([]);
    void models;
  });
});
