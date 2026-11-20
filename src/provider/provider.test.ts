import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearRegisteredApiKeys,
  createModel,
  getAvailableModels,
  lookupApiKey,
  registerApiKey,
  resolveModel,
  setCustomModel,
  vendorModelSpec,
  vendorModels,
  verifyModel,
} from './provider.js';

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-provider-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  clearRegisteredApiKeys();
});
afterEach(() => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  delete process.env.TRANSCODE_MODEL;
  rmSync(configDir, { recursive: true, force: true });
});

describe('GLM Coding Plan preset', () => {
  test('resolves the glmc registry id to the coding endpoint', () => {
    const resolved = resolveModel('glmc');
    expect(resolved.id).toBe('glmc');
    expect(resolved.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(resolved.envKey).toBe('GLM_API_KEY');
  });

  test('the glmc:MODEL spec overrides the model name but keeps the coding endpoint', () => {
    const resolved = resolveModel('glmc:glm-4.5');
    expect(resolved.model).toBe('glm-4.5');
    expect(resolved.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
  });

  test('createModel wires the coding base URL into the client config', () => {
    registerApiKey('glmc', 'test-key');
    const provider = createModel('glmc');
    expect(provider.config.baseUrl).toContain('/api/coding/');
    expect(provider.config.model).toBe('glm-4.6');
  });

  test('appears in the model list for /models', () => {
    const entry = getAvailableModels().find((model) => model.id === 'glmc');
    expect(entry?.name).toContain('Coding');
  });
});

describe('vendor model lists', () => {
  test('every vendor exposes at least one curated model', () => {
    for (const model of getAvailableModels()) {
      if (model.id === 'custom') continue; // empty until the gateway is set up
      expect(vendorModels(model.id).length).toBeGreaterThan(0);
    }
  });

  test('glm lists the current model line', () => {
    const glm = vendorModels('glm');
    expect(glm).toContain('glm-4.6');
    expect(glm).toContain('glm-4.5');
  });

  test('spec mapping routes registry ids to provider prefixes', () => {
    expect(vendorModelSpec('deepseek', 'deepseek-reasoner')).toBe('deepseek:deepseek-reasoner');
    expect(vendorModelSpec('opus', 'claude-sonnet-4')).toBe('anthropic:claude-sonnet-4');
    expect(vendorModelSpec('gpt', 'gpt-4o-mini')).toBe('openai:gpt-4o-mini');
    expect(vendorModelSpec('glmc', 'glm-4.5')).toBe('glmc:glm-4.5');
  });
});

describe('key reuse', () => {
  test('a spec inherits the key registered for its vendor prefix', () => {
    registerApiKey('deepseek', 'vendor-key');
    expect(lookupApiKey('deepseek:deepseek-reasoner')).toBe('vendor-key');
  });

  test('glmc reuses the key saved for glm (same credential family)', () => {
    registerApiKey('glm', 'glm-key');
    expect(lookupApiKey('glmc')).toBe('glm-key');
    expect(lookupApiKey('glmc:glm-4.5')).toBe('glm-key');
  });
});

describe('custom gateway', () => {
  test('persists and resolves base URL and model', () => {
    setCustomModel({ baseUrl: 'https://gw.example.com/v1', model: 'my-model' });

    const resolved = resolveModel('custom');
    expect(resolved.model).toBe('my-model');
    expect(resolved.baseUrl).toBe('https://gw.example.com/v1');
    expect(resolved.provider).toBe('openai');

    const overridden = resolveModel('custom:other-model');
    expect(overridden.model).toBe('other-model');
    expect(overridden.baseUrl).toBe('https://gw.example.com/v1');
  });

  test('appears in the model list', () => {
    expect(getAvailableModels().some((model) => model.id === 'custom')).toBe(true);
  });
});

describe('verifyModel', () => {
  test('fails fast with a readable message when no key is available', async () => {
    const result = await verifyModel('deepseek:deepseek-chat', '');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/key/i);
  });
});
