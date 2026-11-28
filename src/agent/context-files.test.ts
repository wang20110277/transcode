import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  contextAncestors,
  findSubdirContext,
  gitRootOf,
  loadHierarchyContext,
  resolveContextImports,
} from './context-files.js';

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

  test('路径别名(symlink vs physical)下 git 边界仍成立,不泄漏仓库外文件', async () => {
    const outer = makeTree(); // macOS: /var/folders/... 拼法,git 返回 /private/var/...
    put(outer, 'AGENTS.md', 'LEAKED: outside the git repo');
    const repo = path.join(outer, 'repo');
    put(repo, 'AGENTS.md', 'inside');
    execFileSync('git', ['init', repo]);
    const files = await loadHierarchyContext(repo); // gitRoot 省略 → gitRootOf 的物理拼法
    expect(files.some((file) => file.content.includes('LEAKED'))).toBe(false);
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

describe('findSubdirContext', () => {
  test('超大说明跳过,大说明钳制到 16K', async () => {
    const root = makeTree();
    put(path.join(root, 'big'), 'AGENTS.md', 'y'.repeat(300 * 1024));
    put(path.join(root, 'huge'), 'AGENTS.md', 'z'.repeat(600 * 1024));

    const big = await findSubdirContext(path.join(root, 'big'), root, new Set<string>());
    expect(big).not.toBeNull();
    expect(big!.content.length).toBeLessThanOrEqual(16_000 + 100); // 16K + 截断标记
    expect(big!.content).toContain('(project instructions truncated)');

    const huge = await findSubdirContext(path.join(root, 'huge'), root, new Set<string>());
    expect(huge).toBeNull();
  });

  test('首次返回、同目录二次 null、cwd 本身 null', async () => {
    const root = makeTree();
    put(path.join(root, 'sub'), 'AGENTS.md', 'sub rules');
    const injected = new Set<string>();

    const first = await findSubdirContext(path.join(root, 'sub'), root, injected);
    expect(first?.content).toBe('sub rules');
    expect(first?.path).toBe(path.join('sub', 'AGENTS.md'));

    expect(await findSubdirContext(path.join(root, 'sub'), root, injected)).toBeNull();
    expect(await findSubdirContext(root, root, injected)).toBeNull();

    const fresh = await findSubdirContext(path.join(root, 'sub'), root, new Set<string>());
    expect(fresh?.content).toBe('sub rules');
  });

  test('子目录说明里的 @ 导入同样展开', async () => {
    const root = makeTree();
    put(path.join(root, 'sub'), 'AGENTS.md', '@./note.md');
    put(path.join(root, 'sub'), 'note.md', 'note body');
    const found = await findSubdirContext(path.join(root, 'sub'), root, new Set<string>());
    expect(found?.content).toContain('note body');
  });
});

describe('contextAncestors', () => {
  test('最近→根,含两端去重', async () => {
    const root = makeTree();
    const deep = path.join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true }); // cwd 必须真实存在(realpath 判定依赖)
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

describe('Minor 清账 D 组', () => {
  test('#12 无说明目录的负缓存:二次调用不再探测', async () => {
    const root = makeTree();
    put(path.join(root, 'plain'), 'a.ts', 'x');
    const injected = new Set<string>();
    const checked = new Set<string>();
    expect(await findSubdirContext(path.join(root, 'plain'), root, injected, checked)).toBeNull();
    const { promises: fsp } = await import('node:fs');
    const realPlain = await fsp.realpath(path.join(root, 'plain'));
    expect(checked.has(realPlain)).toBe(true);
    // 负缓存命中:即便随后创建了说明文件,本次会话也不再返回
    put(path.join(root, 'plain'), 'AGENTS.md', 'late');
    expect(await findSubdirContext(path.join(root, 'plain'), root, injected, checked)).toBeNull();
  });

  test('#14 菱形导入标"已导入"而非"循环";围栏内 @ 不展开', async () => {
    const dir = makeTree();
    put(dir, 'a.md', 'A\n@shared.md');
    put(dir, 'b.md', 'B\n@shared.md');
    put(dir, 'shared.md', 'S');
    put(dir, 'top.md', '@a.md\n@b.md');
    const out = await resolveContextImports('@a.md\n@b.md', dir);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out.match(/S/g)?.length).toBe(1); // 内容只内联一次
    expect(out).toContain('已导入');
    expect(out).not.toContain('循环导入');

    put(dir, 'fence.md', 'FENCE');
    put(dir, 'doc.md', '```\n@fence.md\n```');
    const fenced = await resolveContextImports('```\n@fence.md\n```\n', dir);
    expect(fenced).toContain('@fence.md');
    expect(fenced).not.toContain('FENCE');
  });

  test('#16 去重键用 realpath:符号链接别名同目录只注入一次', async () => {
    const root = makeTree();
    put(path.join(root, 'real'), 'AGENTS.md', 'note');
    const link = path.join(root, 'alias');
    await (await import('node:fs')).promises.symlink(path.join(root, 'real'), link);
    const injected = new Set<string>();
    expect(await findSubdirContext(link, root, injected)).toMatchObject({ content: 'note' });
    expect(await findSubdirContext(path.join(root, 'real'), root, injected)).toBeNull();
  });
});
