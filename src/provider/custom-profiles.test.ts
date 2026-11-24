import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.js';
import {
  customProfileName,
  isCustomModelSpec,
  listCustomGateways,
  lookupApiKey,
  registerApiKey,
  resolveModel,
  saveCustomProfile,
  setCustomModel,
} from './provider.js';

/**
 * Several custom gateways saved side by side. New entries are user profiles
 * (config.profiles), which resolveModel already understands; the single
 * legacy `custom` slot keeps working and is never overwritten by a new entry.
 */

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-custom-profiles-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  delete process.env.TRANSCODE_BASE_URL;
});
afterEach(() => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  delete process.env.TRANSCODE_BASE_URL;
  rmSync(configDir, { recursive: true, force: true });
});

describe('customProfileName', () => {
  test('a model id becomes the entry name', () => {
    expect(customProfileName('qwen3.6-35b-fp8', 'http://10.162.5.19:3000/v1')).toBe('qwen3.6-35b-fp8');
  });

  test('the same model on a second gateway gets the gateway host in its name', () => {
    saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'qwen' });

    expect(customProfileName('qwen', 'https://b.example/v1')).toBe('qwen@b.example');
  });

  test('the same model on the same gateway keeps its name, so the entry is updated in place', () => {
    const first = saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'qwen' });

    const again = saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'qwen' });

    expect(again).toBe(first);
    expect(Object.keys(loadConfig().profiles ?? {})).toEqual(['qwen']);
  });

  test('a third gateway for the same model gets a numbered name', () => {
    saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'qwen' });
    saveCustomProfile({ baseUrl: 'https://a.example/v2', model: 'qwen' });

    expect(customProfileName('qwen', 'https://a.example/v3')).toBe('qwen@a.example-2');
  });

  test('a model id that is also a built-in vendor id never shadows the built-in', () => {
    expect(customProfileName('glm', 'https://gw.example/v1')).toBe('glm@gw.example');
  });

  test('characters a model spec cannot carry are replaced', () => {
    expect(customProfileName('openai/gpt-4.1:mini', 'https://gw.example/v1')).toBe('openai-gpt-4.1-mini');
  });
});

describe('saveCustomProfile', () => {
  test('stores the gateway as a profile keyed by its name and leaves the rest of the config alone', () => {
    setCustomModel({ baseUrl: 'https://legacy.example/v1', model: 'old-model' });

    const name = saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'qwen' });

    expect(name).toBe('qwen');
    expect(loadConfig().profiles).toEqual({
      qwen: { baseUrl: 'https://a.example/v1', model: 'qwen', keyId: 'qwen' },
    });
    expect(loadConfig().custom).toEqual({ baseUrl: 'https://legacy.example/v1', model: 'old-model' });
  });

  test('the saved entry resolves everywhere a model spec is accepted', () => {
    const name = saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'qwen' });
    registerApiKey(name, 'sk-entry');

    const resolved = resolveModel(name);
    expect(resolved.model).toBe('qwen');
    expect(resolved.baseUrl).toBe('https://a.example/v1');
    expect(resolved.provider).toBe('openai');
    expect(lookupApiKey(name)).toBe('sk-entry');
    expect(isCustomModelSpec(name)).toBe(true);
  });
});

describe('listCustomGateways', () => {
  test('empty until a custom gateway is saved', () => {
    expect(listCustomGateways()).toEqual([]);
  });

  test('lists the legacy custom slot with its address', () => {
    setCustomModel({ baseUrl: 'http://10.162.5.19:3000', model: 'qwen3.6-35b-fp8' });

    expect(listCustomGateways()).toEqual([
      { spec: 'custom', model: 'qwen3.6-35b-fp8', baseUrl: 'http://10.162.5.19:3000' },
    ]);
  });

  test('lists every saved custom gateway next to the legacy one, each with its address', () => {
    setCustomModel({ baseUrl: 'http://10.162.5.19:3000/v1', model: 'qwen3.6-35b-fp8' });
    saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'glm-4.6' });
    saveCustomProfile({ baseUrl: 'https://b.example/v1', model: 'glm-4.6' });

    expect(listCustomGateways()).toEqual([
      { spec: 'custom', model: 'qwen3.6-35b-fp8', baseUrl: 'http://10.162.5.19:3000/v1' },
      { spec: 'glm-4.6', model: 'glm-4.6', baseUrl: 'https://a.example/v1' },
      { spec: 'glm-4.6@b.example', model: 'glm-4.6', baseUrl: 'https://b.example/v1' },
    ]);
  });

  test('skips profiles that lack an address or a model', () => {
    saveCustomProfile({ baseUrl: 'https://a.example/v1', model: 'glm-4.6' });
    const cfg = loadConfig();
    cfg.profiles = { ...cfg.profiles, broken: { baseUrl: 'https://x.example/v1', model: '' } };
    saveConfig({ ...cfg, profiles: { ...cfg.profiles, broken: { baseUrl: 'https://x.example/v1', model: '' } } });

    expect(listCustomGateways().map(entry => entry.spec)).toEqual(['glm-4.6']);
  });
});
