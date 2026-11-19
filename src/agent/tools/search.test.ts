import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
