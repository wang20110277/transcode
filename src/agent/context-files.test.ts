import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contextAncestors, gitRootOf, loadHierarchyContext, resolveContextImports } from './context-files.js';

function makeTree(): string {
  return mkdtempSync(path.join(tmpdir(), 'transcode-context-files-'));
}

function put(dir: string, name: string, content: string): void {
  const target = path.join(dir, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
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

describe('resolveContextImports', () => {
  test('整行 @ 展开,路径相对导入文件所在目录', async () => {
    const dir = makeTree();
    put(dir, 'main.md', 'before\n@docs/style.md\nafter');
    put(dir, 'docs/style.md', 'style rules');
    const out = await resolveContextImports(
      (await import('node:fs')).readFileSync(path.join(dir, 'main.md'), 'utf8'),
      dir,
    );
    expect(out).toBe('before\nstyle rules\nafter');
  });

  test('深度 ≤3,第四层不展开并标注', async () => {
    const dir = makeTree();
    put(dir, 'top.md', '@a.md');
    put(dir, 'a.md', 'A\n@b.md');
    put(dir, 'b.md', 'B\n@c.md');
    put(dir, 'c.md', 'C\n@d.md');
    put(dir, 'd.md', 'D');
    const out = await resolveContextImports('@a.md', dir);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C');
    expect(out).not.toContain('\nD');
    expect(out).toContain('(@d.md 超过导入深度上限)');
  });

  test('单文件 64KB 截断', async () => {
    const dir = makeTree();
    put(dir, 'big.md', 'x'.repeat(65 * 1024));
    put(dir, 'top.md', '@big.md');
    const out = await resolveContextImports('@big.md', dir);
    expect(out.length).toBeGreaterThanOrEqual(64 * 1024);
    expect(out.length).toBeLessThan(65 * 1024);
    expect(out).toContain('(@big.md 超过 64KB,已截断)');
  });

  test('循环导入跳过,不死循环', async () => {
    const dir = makeTree();
    put(dir, 'a.md', 'A\n@b.md');
    put(dir, 'b.md', 'B\n@a.md');
    const out = await resolveContextImports('@a.md', dir);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('(@a.md 循环导入,已跳过)');
  });

  test('缺失路径与目录都标注降级,不抛错', async () => {
    const dir = makeTree();
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    const out = await resolveContextImports('@nope.md\n@sub', dir);
    expect(out).toContain('(@nope.md 导入失败:文件不存在)');
    expect(out).toContain('(@sub 导入失败:文件不存在)');
  });

  test('行内 @ 不处理', async () => {
    const dir = makeTree();
    const line = '详见 @foo.md 的说明';
    expect(await resolveContextImports(line, dir)).toBe(line);
  });
});

describe('loadHierarchyContext + @导入集成', () => {
  test('层级文件内的 @ 导入展开且吃总预算', async () => {
    const root = makeTree();
    put(root, 'AGENTS.md', '@./extra.md');
    put(root, 'extra.md', 'extra rules');
    const files = await loadHierarchyContext(root, { gitRoot: root });
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain('extra rules');

    const tight = await loadHierarchyContext(root, { gitRoot: root, budget: 5 });
    expect(tight[0]!.content).toContain('(project instructions truncated)');
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
