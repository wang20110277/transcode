import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contextAncestors, gitRootOf, loadHierarchyContext } from './context-files.js';

function makeTree(): string {
  return mkdtempSync(path.join(tmpdir(), 'transcode-context-files-'));
}

function put(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), content);
}

describe('loadHierarchyContext', () => {
  test('多级目录:根→最近排序,每级只取一个', async () => {
    const root = makeTree();
    put(root, 'AGENTS.md', 'root rules');
    put(path.join(root, 'mid'), 'CLAUDE.md', 'mid rules');
    const leaf = path.join(root, 'mid', 'leaf');
    put(leaf, 'TRANS.md', 'leaf rules');
    const files = await loadHierarchyContext(leaf, { gitRoot: root });
    expect(files.map((file) => file.path)).toEqual(['../../AGENTS.md', '../CLAUDE.md', 'TRANS.md']);
    expect(files.map((file) => file.content)).toEqual(['root rules', 'mid rules', 'leaf rules']);
  });

  test('每级按优先级取第一个命中', async () => {
    const root = makeTree();
    put(root, 'CLAUDE.md', 'claude');
    put(root, 'TRANS.md', 'trans');
    const files = await loadHierarchyContext(root, { gitRoot: root });
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toBe('trans');
  });

  test('预算最近优先,远级截断', async () => {
    const root = makeTree();
    put(root, 'AGENTS.md', 'r'.repeat(100));
    const leaf = path.join(root, 'leaf');
    put(leaf, 'AGENTS.md', 'l'.repeat(100));
    const files = await loadHierarchyContext(leaf, { gitRoot: root, budget: 120 });
    expect(files.map((file) => file.path)).toEqual(['../AGENTS.md', 'AGENTS.md']);
    expect(files[1]!.content).toBe('l'.repeat(100));
    expect(files[0]!.content).toContain('r'.repeat(20));
    expect(files[0]!.content).toContain('(project instructions truncated)');
  });

  test('git 根为界,仓库外不载入', async () => {
    const outer = makeTree();
    put(outer, 'AGENTS.md', 'outside');
    const root = path.join(outer, 'repo');
    put(root, 'AGENTS.md', 'inside');
    const files = await loadHierarchyContext(root, { gitRoot: root });
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toBe('inside');
  });

  test('无 git 时最多向上 5 级', async () => {
    const base = makeTree();
    put(base, 'AGENTS.md', 'level-1-too-far');
    let cwd = base;
    for (let i = 2; i <= 6; i++) {
      cwd = path.join(cwd, `d${i}`);
      put(cwd, 'AGENTS.md', `level-${i}`);
    }
    const files = await loadHierarchyContext(cwd, { gitRoot: null });
    expect(files).toHaveLength(5);
    expect(files.some((file) => file.content === 'level-1-too-far')).toBe(false);
    expect(files[4]!.content).toBe('level-6');
  });

  test('空文件视为未命中', async () => {
    const root = makeTree();
    put(root, 'AGENTS.md', '   \n\t\n');
    const files = await loadHierarchyContext(root, { gitRoot: root });
    expect(files).toHaveLength(0);
  });
});

describe('contextAncestors', () => {
  test('最近→根,含两端去重', async () => {
    const root = makeTree();
    const deep = path.join(root, 'a', 'b');
    expect(await contextAncestors(deep, root)).toEqual([deep, path.join(root, 'a'), root]);
  });
});

describe('gitRootOf', () => {
  test('非 git 目录 → null;git 仓库 → 绝对路径', async () => {
    expect(await gitRootOf(makeTree())).toBeNull();
    const repoRoot = await gitRootOf(process.cwd());
    expect(repoRoot).toBeTruthy();
    expect(path.isAbsolute(repoRoot!)).toBe(true);
  });
});
