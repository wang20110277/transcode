import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INIT_PROMPT, loadProjectContext } from './system-prompt.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'transcode-init-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('loadProjectContext', () => {
  test('reads TRANS.md as a project context file', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'TRANS.md'), '# Project\nSome rules.\n');

    const context = await loadProjectContext(dir);
    const entry = context.projectFiles.find((file) => file.path === 'TRANS.md');
    expect(entry).toBeDefined();
    expect(entry?.content).toContain('Some rules.');
  });

  test('reads CLAUDE.md and AGENTS.md too, with TRANS.md taking priority', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'TRANS.md'), 'trans rules\n');
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'claude rules\n');
    writeFileSync(path.join(dir, 'AGENTS.md'), 'agents rules\n');

    const context = await loadProjectContext(dir);
    expect(context.projectFiles.map((file) => file.path)).toEqual([
      'TRANS.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
  });

  test('returns no project files when none exist', async () => {
    const context = await loadProjectContext(workspace());
    expect(context.projectFiles.length).toBe(0);
  });
});

describe('INIT_PROMPT', () => {
  test('instructs the agent to analyze the project and write TRANS.md only', () => {
    expect(INIT_PROMPT).toContain('TRANS.md');
    expect(INIT_PROMPT.toLowerCase()).toContain('analyze');
  });
});
