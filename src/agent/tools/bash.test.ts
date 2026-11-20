import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bashTool, bashOutputTool } from './bash.js';
import { createToolSession, type ToolSession } from './session.js';
import type { ToolContext } from './types.js';

describe('background bash', () => {
  test('run_in_background returns immediately; bash_output waits and reads the log', async () => {
    const session = createToolSession(workspace());
    const start = await bashTool.execute(
      { command: 'printf bg-done-XYZ', run_in_background: true },
      ctx(session),
    );

    expect(start).toMatch(/bg-\d+ started/);
    const id = /bg-\d+/.exec(start)![0]!;

    const output = await bashOutputTool.execute(
      { task_id: id, wait: true },
      ctx(session),
    );
    expect(output).toContain('bg-done-XYZ');
    expect(output).toMatch(/exited/);
  });

  test('bash_output without a task_id lists the background tasks', async () => {
    const session = createToolSession(workspace());
    const start = await bashTool.execute(
      { command: 'sleep 2', run_in_background: true },
      ctx(session),
    );
    const id = /bg-\d+/.exec(start)![0]!;

    const listing = await bashOutputTool.execute({}, ctx(session));
    expect(listing).toContain(id);
    expect(listing).toContain('sleep 2');
    expect(listing).toMatch(/running/);
  });

  test('bash_output rejects unknown ids', async () => {
    const session = createToolSession(workspace());
    await expect(
      bashOutputTool.execute({ task_id: 'bg-999' }, ctx(session)),
    ).rejects.toThrow(/bg-999/);
  });
});

describe('bash tool wiring', () => {
  test('description uses claudecode-style hard wording against file dumps', () => {
    const d = bashTool.description;
    expect(d).toContain('IMPORTANT');
    expect(d).toContain('NOT cat');
    expect(d).toContain('NOT sed');
    expect(d).toContain('glob');
    expect(d).toContain('write_file');
    expect(d).toContain('Never repeat');
    expect(d).toContain('absolute paths');
  });

  test('isReadOnly is wired to the analyzer', () => {
    expect(bashTool.isReadOnly?.({ command: 'cat config.py 2>/dev/null' })).toBe(true);
    expect(bashTool.isReadOnly?.({ command: 'npm install' })).toBe(false);
  });
});

const cleanups: Array<() => void> = [];
const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'transcode-bash-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ctx(session: ToolSession): ToolContext {
  return { cwd: session.cwd, session };
}

async function run(session: ToolSession, command: string, input: Record<string, unknown> = {}) {
  const result = await bashTool.execute({ command, ...input }, ctx(session));
  return result;
}

describe('bash tool', () => {
  test('runs a simple command and returns its output', async () => {
    const session = createToolSession(workspace());
    const output = await run(session, 'echo hello-tools');
    expect(output).toContain('hello-tools');
    expect(output).toContain('[exit] code=0');
  });

  test('cd persists across bash calls', async () => {
    const dir = workspace();
    mkdirSync(path.join(dir, 'sub'));
    const session = createToolSession(dir);

    await run(session, 'cd sub');
    // pwd -P captures the physical path (/private/var/... on macOS).
    expect(session.cwd).toBe(path.join(realpathSync(dir), 'sub'));

    const output = await run(session, 'basename "$(pwd)"');
    expect(output).toContain('sub');
  });

  test('failed command still updates the session cwd', async () => {
    const dir = workspace();
    mkdirSync(path.join(dir, 'sub'));
    const session = createToolSession(dir);

    // A failing (non-zero) command must still update cwd; note that a literal
    // `exit N` cannot — it terminates the shell before the pwd trailer runs.
    const output = await run(session, 'cd sub && cat /nonexistent-file');
    expect(output).toContain('code=1');
    expect(session.cwd).toBe(path.join(realpathSync(dir), 'sub'));
  });

  test('injects GIT_EDITOR and TRANSCODE environment markers', async () => {
    const session = createToolSession(workspace());
    const output = await run(session, 'echo "$GIT_EDITOR/$TRANSCODE"');
    expect(output).toContain('true/1');
  });

  test('aliases from the user shell config survive via the snapshot', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'transcode-home-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(path.join(home, '.bashrc'), "alias tsmoke='echo alias-ok'\\n");
    setEnv('HOME', home);
    setEnv('SHELL', '/bin/bash');

    const session = createToolSession(workspace());
    const output = await run(session, 'tsmoke');
    expect(output).toContain('alias-ok');
  });

  test('times out long-running commands and reports it', async () => {
    const session = createToolSession(workspace());
    const output = await run(session, 'sleep 5', { timeout_ms: 1000 });
    expect(output).toMatch(/timed out after 1000ms/);
  });

  test('truncates oversized output keeping head and tail', async () => {
    const session = createToolSession(workspace());
    const output = await run(session, "head -c 60000 /dev/zero | tr '\\0' x");
    expect(output).toContain('[35000 bytes truncated]');
    expect(output.startsWith('xxxx')).toBe(true);
    expect(output.includes('x'.repeat(10000))).toBe(true);
    expect(output.length).toBeLessThan(30000);
  });

  test('recovers to the workspace root when the cwd was deleted', async () => {
    const dir = workspace();
    const session = createToolSession(dir);
    session.cwd = path.join(dir, 'gone');

    const output = await run(session, 'basename "$(pwd)"');
    expect(output).toContain(path.basename(dir));
    expect(session.cwd).toBe(realpathSync(dir));
  });
});
