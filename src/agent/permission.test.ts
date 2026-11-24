import { afterEach, describe, expect, test } from 'bun:test';
import {
  getPermissionMode,
  PERMISSION_MODES,
  resetPermissionMode,
  setPermissionMode,
  subscribePermissionMode,
  type PermissionMode,
} from './permission.js';

const savedEnv: string | undefined = process.env.TRANSCODE_PERMISSION_MODE;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TRANSCODE_PERMISSION_MODE;
  else process.env.TRANSCODE_PERMISSION_MODE = savedEnv;
  resetPermissionMode();
});

describe('permission mode', () => {
  test('defaults to ask', () => {
    delete process.env.TRANSCODE_PERMISSION_MODE;
    resetPermissionMode();
    expect(getPermissionMode()).toBe('ask');
  });

  test('initializes from the environment variable', () => {
    process.env.TRANSCODE_PERMISSION_MODE = 'AUTO';
    resetPermissionMode();
    expect(getPermissionMode()).toBe('auto');
  });

  test('invalid environment value falls back to ask', () => {
    process.env.TRANSCODE_PERMISSION_MODE = 'yolo';
    resetPermissionMode();
    expect(getPermissionMode()).toBe('ask');
  });

  test('switches at runtime', () => {
    setPermissionMode('auto');
    expect(getPermissionMode()).toBe('auto');
    setPermissionMode('readonly');
    expect(getPermissionMode()).toBe('readonly');
  });

  test('rejects unknown modes', () => {
    expect(() => setPermissionMode('yolo' as never)).toThrow();
    expect(getPermissionMode()).toBe('ask');
  });

  test('documents the mode list', () => {
    expect(PERMISSION_MODES).toEqual(['ask', 'auto', 'readonly']);
  });
});

describe('subscribePermissionMode', () => {
  test('切换模式会通知订阅者新模式;退订后不再通知', () => {
    const seen: PermissionMode[] = [];
    const unsubscribe = subscribePermissionMode(mode => seen.push(mode));
    setPermissionMode('auto');
    setPermissionMode('readonly');
    unsubscribe();
    setPermissionMode('ask');
    expect(seen).toEqual(['auto', 'readonly']);
  });
});

describe('nextPermissionMode', () => {
  test('shift+tab 循环:ask → auto → readonly → ask', async () => {
    const { nextPermissionMode } = await import('./permission.js');
    expect(nextPermissionMode('ask')).toBe('auto');
    expect(nextPermissionMode('auto')).toBe('readonly');
    expect(nextPermissionMode('readonly')).toBe('ask');
  });
});
