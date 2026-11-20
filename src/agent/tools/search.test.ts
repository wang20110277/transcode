import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { globTool, grepTool } from './search.js';
import { createToolSession, type ToolSession } from './session.js';
import type { ToolContext } from './types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'transcode-search-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ctx(session: ToolSession): ToolContext {
  return { cwd: session.cwd, session };
}

describe('glob', () => {
  test('finds files by pattern with workspace-relative paths', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.ts'), 'x');
    writeFileSync(path.join(dir, 'b.txt'), 'x');

    const session = createToolSession(dir);
    const output = await globTool.execute({ pattern: '**/*.ts' }, ctx(session));
    expect(output).toContain('a.ts');
    expect(output).not.toContain('b.txt');
  });
});

describe('grep', () => {
  test('returns path:line matches', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'code.ts'), 'const alpha = 1;\nconst beta = 2;\n');

    const session = createToolSession(dir);
    const output = await grepTool.execute({ pattern: 'beta' }, ctx(session));
    expect(output).toContain('code.ts:2: const beta = 2;');
  });

  test('reports when nothing matches', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'code.ts'), 'const alpha = 1;\n');

    const session = createToolSession(dir);
    const output = await grepTool.execute({ pattern: 'nope-xyz' }, ctx(session));
    expect(output).toContain('No matches');
  });

  test('context lines appear with - markers and -- group separators', async () => {
    const dir = workspace();
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    writeFileSync(path.join(dir, 'ctx.txt'), `${lines.join('\n')}\n`);

    const session = createToolSession(dir);
    const output = await grepTool.execute(
      { pattern: 'line 2$|line 10', context: 1 },
      ctx(session),
    );

    expect(output).toContain('ctx.txt:2: line 2');
    expect(output).toContain('ctx.txt-3- line 3');
    expect(output).toContain('ctx.txt:10: line 10');
    expect(output).toContain('--');
  });

  test('multiline patterns match across lines only with multiline: true', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'fn.ts'), 'function foo(\n  x: number\n) {\n  return x;\n}\n');

    const session = createToolSession(dir);
    const single = await grepTool.execute({ pattern: 'foo\\([\\s\\S]*?return' }, ctx(session));
    expect(single).toContain('No matches');

    const multi = await grepTool.execute(
      { pattern: 'foo\\([\\s\\S]*?return', multiline: true },
      ctx(session),
    );
    expect(multi).toContain('fn.ts:1-4:');
  });

  test('respects .gitignore inside a git repository', async () => {
    const dir = workspace();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(path.join(dir, '.gitignore'), 'ignored-dir/\n*.tmp\n');
    writeFileSync(path.join(dir, 'src.txt'), 'target found here\n');
    mkdirSync(path.join(dir, 'ignored-dir'));
    writeFileSync(path.join(dir, 'ignored-dir', 'hidden.txt'), 'target also here\n');
    writeFileSync(path.join(dir, 'noise.tmp'), 'target noise\n');

    const session = createToolSession(dir);
    const output = await grepTool.execute({ pattern: 'target' }, ctx(session));
    expect(output).toContain('src.txt');
    expect(output).not.toContain('hidden.txt');
    expect(output).not.toContain('noise.tmp');

    const files = await globTool.execute({ pattern: '**/*' }, ctx(session));
    expect(files).toContain('src.txt');
    expect(files).not.toContain('hidden.txt');
    expect(files).not.toContain('noise.tmp');
  });
});
