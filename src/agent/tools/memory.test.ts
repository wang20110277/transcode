import { describe, expect, test } from 'bun:test';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolSession, type ToolSession } from './session.js';
import type { ToolContext } from './types.js';
import { memoryDeleteTool, memorySaveTool } from './memory.js';
import { loadUserMemory } from '../memory.js';

let root: string;

async function withRoot(run: (session: ToolSession) => Promise<void>): Promise<void> {
  root = mkdtempSync(path.join(tmpdir(), 'transcode-memory-tool-'));
  process.env.TRANSCODE_USER_DIR = root;
  const session = createToolSession(root);
  try {
    await run(session);
  } finally {
    delete process.env.TRANSCODE_USER_DIR;
    rmSync(root, { recursive: true, force: true });
  }
}

function ctx(session: ToolSession): ToolContext {
  return { cwd: session.cwd, session };
}

describe('memory tools', () => {
  test('memory_save 经 execute 落盘:文件 + 索引 + 返回含 name/type', async () => {
    await withRoot(async (session) => {
      const out = await memorySaveTool.execute(
        {
          name: 'commit-style-zh',
          type: 'feedback',
          content: 'Commit messages written in Chinese.',
          description: '中文 commit 惯例',
        },
        ctx(session),
      );

      expect(out).toContain('commit-style-zh');
      expect(out).toContain('feedback');

      const loaded = await loadUserMemory();
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0].name).toBe('commit-style-zh');
      const index = await fs.readFile(
        path.join(root, 'memory', 'MEMORY.md'),
        'utf8',
      );
      expect(index).toContain('- [commit-style-zh](commit-style-zh.md) — 中文 commit 惯例');
    });
  });

  test('memory_delete 经 execute 删条目,未命中返回 "not found" 文案', async () => {
    await withRoot(async (session) => {
      await memorySaveTool.execute(
        { name: 'temp-note', type: 'user', content: 'soon gone' },
        ctx(session),
      );

      const out = await memoryDeleteTool.execute({ name: 'temp-note' }, ctx(session));
      expect(out).not.toContain('not found');
      expect((await loadUserMemory()).entries).toHaveLength(0);

      const miss = await memoryDeleteTool.execute({ name: 'no-such' }, ctx(session));
      expect(miss).toContain('not found');
    });
  });

  test('两工具 isMutating === true(被 plan/readonly 门禁拒绝的根据)', () => {
    expect(memorySaveTool.isMutating).toBe(true);
    expect(memoryDeleteTool.isMutating).toBe(true);
  });

  test('危险 name 经工具返回 Error 文案而非抛异常', async () => {
    await withRoot(async (session) => {
      const out = await memorySaveTool.execute(
        { name: 'a/b', type: 'user', content: 'x' },
        ctx(session),
      );
      expect(out).toContain('Error');

      const del = await memoryDeleteTool.execute({ name: '..' }, ctx(session));
      expect(del).toContain('not found');
    });
  });
});
