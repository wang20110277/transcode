import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { editFileTool, readFileTool, writeFileTool } from './files.js';
import { invokeTool } from './index.js';
import { createToolSession } from './session.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'transcode-diff-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('tool diff plumbing', () => {
  test('edit_file returns a unified diff via invokeTool', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const session = createToolSession(dir);

    await invokeTool(readFileTool, { path: 'a.txt' }, { cwd: dir, session });
    const result = await invokeTool(
      editFileTool,
      { path: 'a.txt', old_string: 'two', new_string: 'TWO' },
      { cwd: dir, session },
    );

    expect(result.ok).toBe(true);
    expect(result.diff).toBeDefined();
    expect(result.diff).toContain('-two');
    expect(result.diff).toContain('+TWO');
  });

  test('write_file returns an all-additions diff for a new file (capped)', async () => {
    const dir = workspace();
    const session = createToolSession(dir);

    const result = await invokeTool(
      writeFileTool,
      { path: 'new.txt', content: 'l1\nl2\nl3\n' },
      { cwd: dir, session },
    );

    expect(result.ok).toBe(true);
    expect(result.diff).toBeDefined();
    expect(result.diff).toContain('+l1');
    expect(result.diff).toContain('+l3');
  });

  test('write_file returns a line diff when overwriting', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'keep\nold\n');
    const session = createToolSession(dir);

    await invokeTool(readFileTool, { path: 'a.txt' }, { cwd: dir, session });
    const result = await invokeTool(
      writeFileTool,
      { path: 'a.txt', content: 'keep\nnew\n' },
      { cwd: dir, session },
    );

    expect(result.ok).toBe(true);
    expect(result.diff).toContain('-old');
    expect(result.diff).toContain('+new');
  });

  test('plain string execute results carry no diff', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const session = createToolSession(dir);

    const result = await invokeTool(readFileTool, { path: 'a.txt' }, { cwd: dir, session });
    expect(result.ok).toBe(true);
    expect(result.diff).toBeUndefined();
  });
});
