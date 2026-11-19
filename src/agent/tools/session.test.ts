import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolSession, hasFileBeenRead, markFileRead } from './session.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('createToolSession', () => {
  test('initializes cwd and rootCwd from the workspace root', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'transcode-session-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const session = createToolSession(dir);
    expect(session.cwd).toBe(dir);
    expect(session.rootCwd).toBe(dir);
  });

  test('starts with an empty read-file state', () => {
    const session = createToolSession('/tmp');
    expect(session.readFileState.size).toBe(0);
    expect(hasFileBeenRead(session, '/tmp/whatever.txt')).toBe(false);
  });

  test('markFileRead records absolute paths and hasFileBeenRead finds them', () => {
    const session = createToolSession('/tmp');
    markFileRead(session, '/tmp/a.txt');
    expect(hasFileBeenRead(session, '/tmp/a.txt')).toBe(true);
    expect(hasFileBeenRead(session, '/tmp/b.txt')).toBe(false);
  });
});
