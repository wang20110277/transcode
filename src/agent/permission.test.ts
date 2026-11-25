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

  test('initializes to plan from the environment variable', () => {
    process.env.TRANSCODE_PERMISSION_MODE = 'plan';
    resetPermissionMode();
    expect(getPermissionMode()).toBe('plan');
  });

  test('switches at runtime', () => {
    setPermissionMode('auto');
    expect(getPermissionMode()).toBe('auto');
    setPermissionMode('readonly');
    expect(getPermissionMode()).toBe('readonly');
  });

  test('switches to plan at runtime', () => {
    setPermissionMode('plan');
    expect(getPermissionMode()).toBe('plan');
  });

  test('rejects unknown modes', () => {
    expect(() => setPermissionMode('yolo' as never)).toThrow();
    expect(getPermissionMode()).toBe('ask');
  });

  test('lists the modes in shift+tab order: ask, readonly, plan, auto', () => {
    expect(PERMISSION_MODES).toEqual(['ask', 'readonly', 'plan', 'auto']);
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
  test('shift+tab 循环:ask → readonly → plan → auto → ask(先问、再只读、再计划、最后执行)', async () => {
    const { nextPermissionMode } = await import('./permission.js');
    expect(nextPermissionMode('ask')).toBe('readonly');
    expect(nextPermissionMode('readonly')).toBe('plan');
    expect(nextPermissionMode('plan')).toBe('auto');
    expect(nextPermissionMode('auto')).toBe('ask');
  });
});
