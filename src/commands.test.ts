import { afterEach, describe, expect, test } from 'bun:test';
import { executeCommand, findCommand, getCommands, type Command } from './commands.js';
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

  test('/mode <x> switches the runtime mode silently (empty output lands nothing in the transcript)', async () => {
    const mode = findCommand('mode')!;
    const ctx = { modelId: 'deepseek', setModelId: () => {}, clearHistory: () => {} };
    const first = await mode.execute(['auto'], ctx);
    expect(getPermissionMode()).toBe('auto');
    expect(first.output).toBe('');

    const result = await mode.execute(['readonly'], ctx);
    expect(getPermissionMode()).toBe('readonly');
    // The REPL only lands a history entry for non-empty output; the mode
    // indicator under the input box is the sole feedback for a switch.
    expect(result.output).toBe('');
  });

  test('/mode bogus reports the valid modes without switching', async () => {
    const mode = findCommand('mode')!;
    const result = await mode.execute(['bogus'], { modelId: 'deepseek', setModelId: () => {}, clearHistory: () => {} });
    expect(result.output).toContain('Unknown mode');
    expect(getPermissionMode()).toBe('ask');
  });
});

describe('memory commands', () => {
  const ctx = { modelId: 'deepseek', setModelId: () => {}, clearHistory: () => {} };

  async function withMemoryRoot(run: () => Promise<void>): Promise<void> {
    const { mkdtempSync, promises: fs, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = mkdtempSync(path.join(tmpdir(), 'transcode-memory-cmd-'));
    process.env.TRANSCODE_USER_DIR = root;
    try {
      await run();
    } finally {
      delete process.env.TRANSCODE_USER_DIR;
      rmSync(root, { recursive: true, force: true });
      void fs;
    }
  }

  test('/memory:有记忆 → 列索引行 + 根路径 + 提示;空态 → "No memories yet" 引导 /remember', async () => {
    await withMemoryRoot(async () => {
      const { saveMemory } = await import('./agent/memory.js');
      await saveMemory({ name: 'pref-editor', type: 'user', content: 'Vim everywhere.', description: '编辑器偏好' });

      const memory = findCommand('memory')!;
      const result = await memory.execute([], ctx);
      expect(result.output).toContain('pref-editor');
      expect(result.output).toContain('编辑器偏好');
      expect(result.output).toContain('/remember');
      expect(result.output).toContain('/forget');
    });

    await withMemoryRoot(async () => {
      const memory = findCommand('memory')!;
      const empty = await memory.execute([], ctx);
      expect(empty.output).toContain('No memories yet');
      expect(empty.output).toContain('/remember');
    });
  });

  test('/remember 一段话 → 存为 type=user,content=原文,输出确认与 name;同名冲突加 -2 后缀;纯中文取名前 8 字符', async () => {
    await withMemoryRoot(async () => {
      const { loadUserMemory, saveMemory } = await import('./agent/memory.js');
      const remember = findCommand('remember')!;

      const result = await remember.execute(['prefer', 'bun', 'over', 'node'], ctx);
      expect(result.output).toContain('prefer-bun-over-node');
      const saved = await loadUserMemory();
      expect(saved.entries[0]).toMatchObject({
        name: 'prefer-bun-over-node',
        type: 'user',
        content: 'prefer bun over node',
      });

      await saveMemory({ name: 'prefer-bun-over-node', type: 'user', content: '占位' });
      const clash = await remember.execute(['prefer', 'bun', 'over', 'node', 'now'], ctx);
      expect(clash.output).toContain('prefer-bun-over-node-2');

      const cjk = await remember.execute(['中文偏好测试'], ctx);
      expect(cjk.output).toContain('中文偏好测试');
      const after = await loadUserMemory();
      expect(after.entries.some((e) => e.name === '中文偏好测试' && e.content === '中文偏好测试')).toBe(true);
    });
  });

  test('/forget 命中 → "Forgot <name>.";未命中 → "No memory named"', async () => {
    await withMemoryRoot(async () => {
      const { saveMemory } = await import('./agent/memory.js');
      await saveMemory({ name: 'drop-me', type: 'user', content: 'x', description: 'd' });

      const forget = findCommand('forget')!;
      const hit = await forget.execute(['drop-me'], ctx);
      expect(hit.output).toContain('Forgot drop-me.');

      const miss = await forget.execute(['no-such'], ctx);
      expect(miss.output).toContain('No memory named');
    });
  });
});

describe('executeCommand error containment', () => {
  test('命令 execute 抛异常 → 返回错误文案而非向上抛', async () => {
    const boom: Command = {
      name: 'boom',
      description: 'throws',
      execute: () => {
        throw new Error('EACCES: permission denied');
      },
    };
    const result = await executeCommand(boom, [], { modelId: 'deepseek', setModelId: () => {}, clearHistory: () => {} });
    expect(result.output).toContain('Command failed');
    expect(result.output).toContain('EACCES');
  });
});

describe('search command registration', () => {
  test('is registered so /help lists it', () => {
    const search = findCommand('search');
    expect(search).toBeDefined();
    expect(search?.description.length).toBeGreaterThan(0);
    expect(getCommands().map((c) => c.name)).toContain('search');
  });
});

describe('compact command description', () => {
  test('无参查看语义在桩文案中可发现', () => {
    const compact = findCommand('compact');
    expect(compact?.description).toContain('查看上下文预算');
  });
});
