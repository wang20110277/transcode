import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INIT_PROMPT, buildSystemPrompt, loadProjectContext } from './system-prompt.js';
import { setRouting } from '../provider/provider.js';

describe('buildSystemPrompt', () => {
  test('steers file inspection away from whole-file cat/sed dumps', () => {
    const prompt = buildSystemPrompt(
      { cwd: '/tmp', projectFiles: [] },
      { modelName: 'test-model' },
    );
    expect(prompt).toContain('wc -l');
    expect(prompt).toContain('offset');
    expect(prompt.toLowerCase()).toContain('do not cat');
  });

  test('warns that grep -c counts definition lines too', () => {
    const prompt = buildSystemPrompt({ cwd: '/tmp', projectFiles: [] });
    expect(prompt).toContain('grep -c');
  });

  test('advertises configured role routing for ask_model delegation', async () => {
    const configDir = await fs.mkdtemp(path.join(tmpdir(), 'transcode-prompt-route-'));
    process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
    try {
      setRouting('analysis', 'glmc');
      setRouting('design', 'opus');
      const prompt = buildSystemPrompt({ cwd: '/tmp', projectFiles: [] });
      expect(prompt).toContain('ask_model');
      expect(prompt).toContain('dispatch_agent');
      expect(prompt).toContain('analysis→glmc');
      expect(prompt).toContain('design→opus');
    } finally {
      delete process.env.TRANSCODE_CONFIG_PATH;
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

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
