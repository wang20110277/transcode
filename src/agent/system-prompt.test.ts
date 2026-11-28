import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
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

  test('同级并存只载 TRANS.md(每级一个,优先级取先)', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'TRANS.md'), 'trans rules\n');
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'claude rules\n');
    writeFileSync(path.join(dir, 'AGENTS.md'), 'agents rules\n');

    const context = await loadProjectContext(dir);
    expect(context.projectFiles.map((file) => file.path)).toEqual(['TRANS.md']);
  });

  test('非 git 目录向上也能载到父级说明(根→最近排序)', async () => {
    const root = workspace();
    writeFileSync(path.join(root, 'AGENTS.md'), 'root rules\n');
    const sub = path.join(root, 'pkg');
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, 'TRANS.md'), 'sub rules\n');

    const context = await loadProjectContext(sub);
    expect(context.projectFiles.map((file) => file.path)).toEqual(['../AGENTS.md', 'TRANS.md']);
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

describe('user memory injection', () => {
  const memory = {
    globalInstructions: 'All projects run on bun.',
    entries: [
      {
        name: 'commit-style-zh',
        type: 'feedback' as const,
        description: '中文 commit 惯例',
        content: 'Commit messages written in Chinese.',
      },
    ],
    omitted: ['stale-pointer'],
  };

  test('userMemory 有内容 → 渲染 ## User memory 段,位于 ## Project instructions 之前', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp',
      projectFiles: [{ path: 'TRANS.md', content: 'project rules' }],
      userMemory: memory,
    });
    expect(prompt).toContain('## User memory');
    expect(prompt.indexOf('## User memory')).toBeLessThan(
      prompt.indexOf('## Project instructions'),
    );
  });

  test('段内含 Global instructions 原文、索引行、各条 #### name 与正文、omitted 注名行', () => {
    const prompt = buildSystemPrompt({ cwd: '/tmp', projectFiles: [], userMemory: memory });
    expect(prompt).toContain('### Global instructions');
    expect(prompt).toContain('All projects run on bun.');
    expect(prompt).toContain('- [commit-style-zh](commit-style-zh.md) — 中文 commit 惯例');
    expect(prompt).toContain('#### commit-style-zh');
    expect(prompt).toContain('Commit messages written in Chinese.');
    expect(prompt).toContain('(omitted: stale-pointer)');
  });

  test('userMemory 为空/缺省 → 不渲染该段;How to work 始终含 memory_save 引导行', () => {
    const empty = buildSystemPrompt({
      cwd: '/tmp',
      projectFiles: [],
      userMemory: { globalInstructions: null, entries: [], omitted: [] },
    });
    expect(empty).not.toContain('## User memory');
    expect(empty).toContain('memory_save');

    const absent = buildSystemPrompt({ cwd: '/tmp', projectFiles: [] });
    expect(absent).not.toContain('## User memory');
    expect(absent).toContain('memory_save');
    expect(absent).toContain('verify it still holds');
  });

  test('loadProjectContext 集成:TRANSCODE_USER_DIR 根下放 TRANS.md + memory 条目 → context.userMemory 装载', async () => {
    const dir = workspace();
    const userRoot = mkdtempSync(path.join(tmpdir(), 'transcode-user-memory-'));
    process.env.TRANSCODE_USER_DIR = userRoot;
    try {
      writeFileSync(path.join(userRoot, 'TRANS.md'), 'Global rule: bun only.\n');
      mkdirSync(path.join(userRoot, 'memory'), { recursive: true });
      writeFileSync(
        path.join(userRoot, 'memory', 'pref-editor.md'),
        '---\nname: pref-editor\ntype: user\ndescription: 编辑器偏好\n---\nVim keybindings everywhere.\n',
      );

      const context = await loadProjectContext(dir);
      expect(context.userMemory?.globalInstructions).toBe('Global rule: bun only.');
      expect(context.userMemory?.entries[0]?.name).toBe('pref-editor');
      expect(context.userMemory?.omitted).toEqual([]);
    } finally {
      delete process.env.TRANSCODE_USER_DIR;
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
});

describe('omitted-only user memory', () => {
  test('全部条目超预算被丢 → 段仍渲染且含 omitted 注名', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp',
      projectFiles: [],
      userMemory: { globalInstructions: null, entries: [], omitted: ['huge'] },
    });
    expect(prompt).toContain('## User memory');
    expect(prompt).toContain('(omitted: huge)');
  });
});

describe('web tool guidance', () => {
  test('webSearch 已配置 → How to work 含 web_search 优先于记忆的引导', async () => {
    const configDir = await fs.mkdtemp(path.join(tmpdir(), 'transcode-prompt-web-'));
    process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
    try {
      writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ webSearch: { provider: 'tavily', apiKey: 'tvly-x' } }),
      );
      const prompt = buildSystemPrompt({ cwd: '/tmp', projectFiles: [] });
      expect(prompt).toContain('web_search');
      expect(prompt).toContain('web_fetch');
      expect(prompt.toLowerCase()).toContain('outside this workspace');
    } finally {
      delete process.env.TRANSCODE_CONFIG_PATH;
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  test('未配置 → 不提 web_search(与工具隐藏一致),仍提 web_fetch', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'transcode-prompt-noweb-'));
    process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'empty.json');
    try {
      writeFileSync(path.join(configDir, 'empty.json'), '{}');
      const prompt = buildSystemPrompt({ cwd: '/tmp', projectFiles: [] });
      expect(prompt).not.toContain('web_search');
      expect(prompt).toContain('web_fetch');
    } finally {
      delete process.env.TRANSCODE_CONFIG_PATH;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
