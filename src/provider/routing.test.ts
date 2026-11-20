import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.js';
import {
  clearRegisteredApiKeys,
  getRouting,
  lookupApiKey,
  resolveModel,
  resolveRole,
  setRouting,
} from './provider.js';

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-routing-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  clearRegisteredApiKeys();
});
afterEach(() => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  rmSync(configDir, { recursive: true, force: true });
});

describe('profiles', () => {
  test('a user profile maps a model id to an endpoint and model name', () => {
    saveConfig({
      ...loadConfig(),
      profiles: {
        'glm-vision': {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          model: 'glm-4.6v',
          keyId: 'glm',
        },
      },
    });

    const resolved = resolveModel('glm-vision');
    expect(resolved.model).toBe('glm-4.6v');
    expect(resolved.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(resolved.envKey).toBe('GLM_API_KEY');
  });

  test('a user profile overrides a built-in registry id of the same name', () => {
    saveConfig({
      ...loadConfig(),
      profiles: {
        deepseek: {
          baseUrl: 'https://relay.example.com/v1',
          model: 'deepseek-reasoner',
          keyId: 'deepseek',
        },
      },
    });

    const resolved = resolveModel('deepseek');
    expect(resolved.model).toBe('deepseek-reasoner');
    expect(resolved.baseUrl).toBe('https://relay.example.com/v1');
  });

  test('keyId references the shared key store', () => {
    saveConfig({
      ...loadConfig(),
      apiKeys: { glm: 'glm-key' },
      profiles: {
        'glm-vision': {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          model: 'glm-4.6v',
          keyId: 'glm',
        },
      },
    });

    expect(lookupApiKey('glm-vision')).toBe('glm-key');
  });

  test('unknown names keep the legacy resolution behavior', () => {
    const resolved = resolveModel('kimi');
    expect(resolved.baseUrl).toBe('https://api.moonshot.cn/v1');
  });
});

describe('role routing', () => {
  test('roles are arbitrary names mapped to profiles', () => {
    setRouting('analysis', 'glm-coding');
    setRouting('design', 'opus');
    expect(getRouting()).toEqual({ analysis: 'glm-coding', design: 'opus' });
  });

  test('resolveRole maps a role through to the profile model', () => {
    setRouting('analysis', 'glmc');
    const resolved = resolveRole('analysis');
    expect(resolved?.model).toBe('glm-4.6');
    expect(resolved?.baseUrl).toContain('/api/coding/');
  });

  test('removing a role with "-" clears it', () => {
    setRouting('analysis', 'glmc');
    setRouting('analysis', '-');
    expect(getRouting().analysis).toBeUndefined();
    expect(resolveRole('analysis')).toBeUndefined();
  });

  test('routing persists across config loads', () => {
    setRouting('review', 'deepseek');
    expect(loadConfig().routing?.review).toBe('deepseek');
  });
});
