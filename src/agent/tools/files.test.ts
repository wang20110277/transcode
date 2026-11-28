import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  test('子目录说明懒加载:首读附加,同目录再读不重复,根目录文件不附加', async () => {
    const dir = workspace();
    const session = createToolSession(dir);
    writeFileSync(path.join(dir, 'README.md'), 'readme\n');
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub', 'AGENTS.md'), 'sub rules\n');
    writeFileSync(path.join(dir, 'sub', 'a.ts'), 'a\n');
    writeFileSync(path.join(dir, 'sub', 'b.ts'), 'b\n');

    const first = await read(session, 'sub/a.ts');
    expect(first).toContain('[(来自 sub/AGENTS.md)]');
    expect(first).toContain('sub rules');

    const second = await read(session, 'sub/b.ts');
    expect(second).not.toContain('[(来自');

    const rootRead = await read(session, 'README.md');
    expect(rootRead).not.toContain('[(来自');
  });

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

  test('returns image files as base64 multimodal content', async () => {
    const dir = workspace();
    const session = createToolSession(dir);
    // Minimal fake PNG: magic bytes + payload.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    writeFileSync(path.join(dir, 'logo.png'), png);

    const result = await readFileTool.execute({ path: 'logo.png' }, ctx(session));
    expect(typeof result).toBe('object');
    const output = result as { output: string; images?: Array<{ data: string; mediaType: string }> };
    expect(output.images?.length).toBe(1);
    expect(output.images?.[0]?.mediaType).toBe('image/png');
    expect(output.images?.[0]?.data).toBe(png.toString('base64'));
    expect(output.output).toContain('image');
    expect(hasFileBeenRead(session, path.join(dir, 'logo.png'))).toBe(true);
  });

  test('rejects oversized images instead of blowing up the context', async () => {
    const dir = workspace();
    const session = createToolSession(dir);
    const huge = Buffer.alloc(3_500_000, 7);
    writeFileSync(path.join(dir, 'big.jpg'), huge);

    await expect(readFileTool.execute({ path: 'big.jpg' }, ctx(session))).rejects.toThrow(
      /3 MB|3MB/,
    );
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

  test('applies multiple edits in one call', async () => {
    const dir = workspace();
    writeFileSync(
      path.join(dir, 'multi.txt'),
      'alpha\nbeta\ngamma\nbeta\n',
    );
    const session = createToolSession(dir);

    await read(session, 'multi.txt');
    const result = await editFileTool.execute(
      {
        path: 'multi.txt',
        edits: [
          { old_string: 'alpha', new_string: 'ALPHA' },
          { old_string: 'gamma', new_string: 'GAMMA' },
          { old_string: 'beta\n', new_string: 'BETA\n', replace_all: true },
        ],
      },
      ctx(session),
    );

    expect(readFileSync(path.join(dir, 'multi.txt'), 'utf8')).toBe('ALPHA\nBETA\nGAMMA\nBETA\n');
    expect(result.output).toContain('Replaced 4 occurrence(s)');
    expect(result.diff).toContain('-alpha');
    expect(result.diff).toContain('+GAMMA');
  });

  test('multi-edit is atomic: a missing edit leaves the file untouched', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    const session = createToolSession(dir);

    await read(session, 'a.txt');
    await expect(
      editFileTool.execute(
        {
          path: 'a.txt',
          edits: [
            { old_string: 'one', new_string: 'ONE' },
            { old_string: 'nope', new_string: 'X' },
          ],
        },
        ctx(session),
      ),
    ).rejects.toThrow(/not found/);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  test('multi-edit rejects an old_string contained in an earlier new_string', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    const session = createToolSession(dir);

    await read(session, 'a.txt');
    await expect(
      editFileTool.execute(
        {
          path: 'a.txt',
          edits: [
            { old_string: 'one', new_string: 'one plus two' },
            { old_string: 'two', new_string: 'TWO' },
          ],
        },
        ctx(session),
      ),
    ).rejects.toThrow(/substring/);
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
