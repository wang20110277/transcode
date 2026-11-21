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
