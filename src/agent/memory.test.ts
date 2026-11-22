import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  USER_MEMORY_BUDGET_CHARS,
  deleteMemory,
  globalInstructionsPath,
  loadUserMemory,
  memoryDir,
  saveMemory,
} from './memory.js';

let root: string;

async function withRoot(run: () => Promise<void>): Promise<void> {
  root = mkdtempSync(path.join(tmpdir(), 'transcode-memory-'));
  process.env.TRANSCODE_USER_DIR = root;
  try {
    await run();
  } finally {
    delete process.env.TRANSCODE_USER_DIR;
    rmSync(root, { recursive: true, force: true });
  }
}

async function writeEntryFile(name: string, raw: string): Promise<void> {
  mkdirSync(memoryDir(), { recursive: true });
  await fs.writeFile(path.join(memoryDir(), `${name}.md`), raw, 'utf8');
}

describe('memory store', () => {
  test('save→load 往返:文件 + 索引 + frontmatter 三键', async () => {
    await withRoot(async () => {
      const entry = await saveMemory({
        name: 'bun-not-node',
        type: 'feedback',
        content: '所有项目用 bun 跑脚本。',
        description: '用户偏好 bun',
      });

      expect(entry.name).toBe('bun-not-node');
      expect(entry.type).toBe('feedback');

      const file = path.join(memoryDir(), 'bun-not-node.md');
      expect(existsSync(file)).toBe(true);
      const raw = await fs.readFile(file, 'utf8');
      expect(raw).toContain('name: bun-not-node');
      expect(raw).toContain('type: feedback');
      expect(raw).toContain('description: 用户偏好 bun');
      expect(raw).toContain('所有项目用 bun 跑脚本。');

      const index = await fs.readFile(path.join(memoryDir(), 'MEMORY.md'), 'utf8');
      expect(index).toContain('- [bun-not-node](bun-not-node.md) — 用户偏好 bun');

      const loaded = await loadUserMemory();
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0]).toEqual(entry);
      expect(loaded.omitted).toEqual([]);
    });
  });

  test('索引是再生产物:手删 MEMORY.md 后 load 仍返回条目,save 后索引重建', async () => {
    await withRoot(async () => {
      await saveMemory({ name: 'a-first', type: 'user', content: '一', description: 'd1' });
      await saveMemory({ name: 'b-second', type: 'user', content: '二', description: 'd2' });
      await fs.rm(path.join(memoryDir(), 'MEMORY.md'));

      const loaded = await loadUserMemory();
      expect(loaded.entries.map((e) => e.name)).toEqual(['a-first', 'b-second']);

      await saveMemory({ name: 'c-third', type: 'user', content: '三', description: 'd3' });
      const index = await fs.readFile(path.join(memoryDir(), 'MEMORY.md'), 'utf8');
      expect(index).toContain('a-first');
      expect(index).toContain('b-second');
      expect(index).toContain('c-third');
    });
  });

  test('预算:大 reference + 小 user 超预算 → user 保留、reference 进 omitted', async () => {
    await withRoot(async () => {
      await saveMemory({
        name: 'aaa-big-ref',
        type: 'reference',
        content: 'x'.repeat(USER_MEMORY_BUDGET_CHARS),
        description: '大引用',
      });
      await saveMemory({ name: 'zzz-user', type: 'user', content: '小而重要', description: '用户事实' });

      const loaded = await loadUserMemory();
      expect(loaded.entries.map((e) => e.name)).toEqual(['zzz-user']);
      expect(loaded.omitted).toEqual(['aaa-big-ref']);
    });
  });

  test('TRANS.md 超预算 → 截断并附 "... (global instructions truncated)"', async () => {
    await withRoot(async () => {
      writeFileSync(globalInstructionsPath(), 'g'.repeat(USER_MEMORY_BUDGET_CHARS + 500));
      const loaded = await loadUserMemory();
      expect(loaded.globalInstructions).not.toBeNull();
      expect((loaded.globalInstructions ?? '').length).toBeLessThanOrEqual(
        USER_MEMORY_BUDGET_CHARS,
      );
      expect(loaded.globalInstructions).toContain('... (global instructions truncated)');
    });
  });

  test('坏 frontmatter(空文件/缺 type/未知 type)→ 跳过该条不崩', async () => {
    await withRoot(async () => {
      await writeEntryFile('empty', '');
      await writeEntryFile('no-frontmatter', '正文没有 frontmatter');
      await writeEntryFile('missing-type', '---\nname: missing-type\ndescription: d\n---\n正文');
      await writeEntryFile('unknown-type', '---\nname: unknown-type\ntype: diary\n---\n正文');
      await saveMemory({ name: 'good-one', type: 'user', content: '好条目', description: 'ok' });

      const loaded = await loadUserMemory();
      expect(loaded.entries.map((e) => e.name)).toEqual(['good-one']);
    });
  });

  test('危险 name(空、a/b、..)→ saveMemory 抛错,deleteMemory 返回 false', async () => {
    await withRoot(async () => {
      await expect(saveMemory({ name: '  ', type: 'user', content: 'x' })).rejects.toThrow();
      await expect(saveMemory({ name: 'a/b', type: 'user', content: 'x' })).rejects.toThrow();
      await expect(saveMemory({ name: '..', type: 'user', content: 'x' })).rejects.toThrow();

      expect(await deleteMemory('a/b')).toBe(false);
      expect(await deleteMemory('..')).toBe(false);
      expect(await deleteMemory('')).toBe(false);
    });
  });

  test('description 缺省取 content 首个非空行截 60 字符', async () => {
    await withRoot(async () => {
      const long = 'a'.repeat(80);
      const entry = await saveMemory({ name: 'derived', type: 'user', content: `\n\n${long}` });
      expect(entry.description).toBe('a'.repeat(60));
    });
  });

  test('deleteMemory:命中删文件并重写索引,未命中返回 false', async () => {
    await withRoot(async () => {
      await saveMemory({ name: 'keep-me', type: 'user', content: '留', description: 'k' });
      await saveMemory({ name: 'drop-me', type: 'user', content: '删', description: 'd' });

      expect(await deleteMemory('drop-me')).toBe(true);
      expect(existsSync(path.join(memoryDir(), 'drop-me.md'))).toBe(false);
      const index = await fs.readFile(path.join(memoryDir(), 'MEMORY.md'), 'utf8');
      expect(index).toContain('keep-me');
      expect(index).not.toContain('drop-me');
      expect(await loadUserMemory()).toMatchObject({ entries: [expect.objectContaining({ name: 'keep-me' })] });

      expect(await deleteMemory('drop-me')).toBe(false);
    });
  });
});
