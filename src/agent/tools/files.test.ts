import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { editFileTool, readFileTool, writeFileTool } from './files.js';
import { createToolSession, hasFileBeenRead, type ToolSession } from './session.js';
import type { ToolContext } from './types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'transcode-files-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ctx(session: ToolSession): ToolContext {
  return { cwd: session.cwd, session };
}

async function read(session: ToolSession, file: string) {
  return readFileTool.execute({ path: file }, ctx(session));
}

async function write(session: ToolSession, file: string, content: string) {
  return writeFileTool.execute({ path: file, content }, ctx(session));
}

async function edit(session: ToolSession, file: string, old_string: string, new_string: string) {
  return editFileTool.execute({ path: file, old_string, new_string }, ctx(session));
}

describe('read_file', () => {
  test('records the file as read in the session', async () => {
    const dir = workspace();
    const session = createToolSession(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

    await read(session, 'a.txt');
    expect(hasFileBeenRead(session, path.join(dir, 'a.txt'))).toBe(true);
  });

  test('truncates lines longer than 2000 characters', async () => {
    const dir = workspace();
    const session = createToolSession(dir);
    writeFileSync(path.join(dir, 'long.txt'), `${'x'.repeat(3000)}\nshort\n`);

    const output = await read(session, 'long.txt');
    expect(output).toContain('[line truncated]');
    expect(output).toContain('short');
    expect(output.length).toBeLessThan(2400);
  });
});

describe('write_file', () => {
  test('allows creating a new file', async () => {
    const dir = workspace();
    const session = createToolSession(dir);

    const result = await write(session, 'new.txt', 'content\n');
    expect(result.output).toContain('Wrote');
    expect(readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('content\n');
  });

  test('refuses to overwrite an existing file that was not read this session', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'original\n');
    const session = createToolSession(dir);

    await expect(write(session, 'a.txt', 'clobbered\n')).rejects.toThrow(/read_file first/);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('original\n');
  });

  test('allows overwriting after the file was read', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'original\n');
    const session = createToolSession(dir);

    await read(session, 'a.txt');
    await write(session, 'a.txt', 'replaced\n');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('replaced\n');
  });
});

describe('edit_file', () => {
  test('refuses to edit a file that was not read this session', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'original\n');
    const session = createToolSession(dir);

    await expect(edit(session, 'a.txt', 'original', 'changed')).rejects.toThrow(
      /read_file first/,
    );
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('original\n');
  });

  test('applies an exact replacement after reading', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n');
    const session = createToolSession(dir);

    await read(session, 'a.txt');
    const result = await edit(session, 'a.txt', 'beta', 'BETA');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');
    expect(result.output).toContain('Replaced 1 occurrence');
  });

  test('falls back to quote normalization when the file uses curly quotes', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'prose.md'), 'He said “don’t stop” loudly\n');
    const session = createToolSession(dir);

    await read(session, 'prose.md');
    await edit(session, 'prose.md', 'He said "don\'t stop" loudly', 'She said "go" now');
    expect(readFileSync(path.join(dir, 'prose.md'), 'utf8')).toBe('She said "go" now\n');
  });

  test('returns a line-numbered snippet around the edit', async () => {
    const dir = workspace();
    const lines = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    writeFileSync(path.join(dir, 'n.txt'), `${lines.join('\n')}\n`);
    const session = createToolSession(dir);

    await read(session, 'n.txt');
    const result = await edit(session, 'n.txt', 'four', 'CHANGED');
    expect(result.output).toContain('CHANGED');
    expect(result.output).toMatch(/4\tCHANGED/);
    expect(result.output).toMatch(/8\teight/);
  });
});
