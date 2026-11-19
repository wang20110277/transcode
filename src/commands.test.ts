import { afterEach, describe, expect, test } from 'bun:test';
import { findCommand, getCommands } from './commands.js';
import { getPermissionMode, resetPermissionMode, setPermissionMode } from './agent/permission.js';

afterEach(() => {
  setPermissionMode('ask');
  resetPermissionMode();
});

describe('init command registration', () => {
  test('is registered so /help lists it', () => {
    const init = findCommand('init');
    expect(init).toBeDefined();
    expect(init?.description.length).toBeGreaterThan(0);
  });

  test('getCommands exposes it alongside the others', () => {
    const names = getCommands().map((command) => command.name);
    expect(names).toContain('init');
    expect(names).toContain('help');
    expect(names).toContain('exit');
  });
});

describe('mode command', () => {
  test('is registered', () => {
    const mode = findCommand('mode');
    expect(mode).toBeDefined();
  });

  test('bare /mode shows the current mode and usage', async () => {
    const mode = findCommand('mode')!;
    const result = await mode.execute([], { modelId: 'deepseek', setModelId: () => {}, clearHistory: () => {} });
    expect(result.output).toContain('ask');
    expect(result.output).toContain('auto');
    expect(result.output).toContain('readonly');
  });

  test('/mode auto switches the runtime mode', async () => {
    const mode = findCommand('mode')!;
    const ctx = { modelId: 'deepseek', setModelId: () => {}, clearHistory: () => {} };
    await mode.execute(['auto'], ctx);
    expect(getPermissionMode()).toBe('auto');

    const result = await mode.execute(['readonly'], ctx);
    expect(getPermissionMode()).toBe('readonly');
    expect(result.output).toContain('readonly');
  });

  test('/mode bogus reports the valid modes without switching', async () => {
    const mode = findCommand('mode')!;
    const result = await mode.execute(['bogus'], { modelId: 'deepseek', setModelId: () => {}, clearHistory: () => {} });
    expect(result.output).toContain('Unknown mode');
    expect(getPermissionMode()).toBe('ask');
  });
});
