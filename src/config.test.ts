import { describe, expect, test } from 'bun:test';
import { normalizeAutoUpdate } from './config.js';

describe('normalizeAutoUpdate', () => {
  test('false disables auto-update, keeping default target and lastCheck', () => {
    expect(normalizeAutoUpdate(false)).toEqual({
      enabled: false,
      target: 'latest',
      lastCheck: 0,
    });
  });

  test('undefined (no config) defaults to enabled', () => {
    expect(normalizeAutoUpdate(undefined)).toEqual({
      enabled: true,
      target: 'latest',
      lastCheck: 0,
    });
  });

  test('an empty object keeps defaults (enabled, latest, 0)', () => {
    expect(normalizeAutoUpdate({})).toEqual({
      enabled: true,
      target: 'latest',
      lastCheck: 0,
    });
  });

  test('an object preserves its fields', () => {
    expect(normalizeAutoUpdate({ enabled: false, target: '0.3.0' })).toEqual({
      enabled: false,
      target: '0.3.0',
      lastCheck: 0,
    });
    expect(
      normalizeAutoUpdate({ enabled: true, target: '0.3.0', lastCheck: 123 }),
    ).toEqual({ enabled: true, target: '0.3.0', lastCheck: 123 });
  });

  test('invalid values fall back to the enabled default instead of throwing', () => {
    for (const raw of ['yes', 5, null, [true]]) {
      expect(normalizeAutoUpdate(raw)).toEqual({
        enabled: true,
        target: 'latest',
        lastCheck: 0,
      });
    }
  });
});

import { normalizeAutoCompact } from './config.js';

describe('normalizeAutoCompact', () => {
  test('undefined → enabled default 200_000; false → disabled; valid override kept', () => {
    expect(normalizeAutoCompact(undefined)).toEqual({ enabled: true, thresholdChars: 200_000, contextTokens: 50_000, keepTurns: 1 });
    expect(normalizeAutoCompact(false)).toEqual({ enabled: false, thresholdChars: 200_000, contextTokens: 50_000, keepTurns: 1 });
    expect(normalizeAutoCompact({ thresholdChars: 50_000 })).toEqual({
      enabled: true,
      thresholdChars: 50_000,
      contextTokens: 12_500,
      keepTurns: 1,
    });
    expect(normalizeAutoCompact({ enabled: false, thresholdChars: 80_000, keepTurns: 5 })).toEqual({
      enabled: false,
      thresholdChars: 80_000,
      contextTokens: 20_000,
      keepTurns: 5,
    });
  });

  test('garbage (string/null/array/negative) falls back to defaults', () => {
    for (const raw of ['yes', 5, null, [1], { thresholdChars: -5 }, { thresholdChars: 'big' }, { keepTurns: 0 }, { keepTurns: 'ten' }]) {
      expect(normalizeAutoCompact(raw)).toEqual({ enabled: true, thresholdChars: 200_000, contextTokens: 50_000, keepTurns: 1 });
    }
  });
});

describe('writeContextTokens', () => {
  test('写入/删除 byModel 条目且不覆盖其它配置段', async () => {
    const { writeContextTokens } = await import('./config.js');
    const { readFileSync, rmSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = mkdtempSync(path.join(tmpdir(), 'transcode-ctx-'));
    const configPath = path.join(root, 'c.json');
    process.env.TRANSCODE_CONFIG_PATH = configPath;
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(configPath, JSON.stringify({ apiKeys: { glm: 'k' }, autoCompact: { enabled: true, keepTurns: 2 } }));
      writeContextTokens('glmc:glm-5.3', 1_000_000);
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(saved.apiKeys).toEqual({ glm: 'k' });
      expect(saved.autoCompact).toEqual({ enabled: true, keepTurns: 2, byModel: { 'glmc:glm-5.3': 1_000_000 } });
      writeContextTokens('glmc:glm-5.3', null);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).autoCompact.byModel).toEqual({});
    } finally {
      delete process.env.TRANSCODE_CONFIG_PATH;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
