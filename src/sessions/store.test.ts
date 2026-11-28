import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  buildSessionRecord,
  getSession,
  listSessions,
  newSessionId,
  saveSession,
  searchSessions,
  type SessionRecord,
} from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'transcode-sessions-test-'));
  process.env.TRANSCODE_SESSIONS_DIR = dir;
});
afterEach(() => {
  delete process.env.TRANSCODE_SESSIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function sample(title: string, body: string): SessionRecord {
  return {
    id: 'ses_test1',
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: '/tmp',
    model: 'deepseek',
    messages: [
      new SystemMessage('system prompt'),
      new HumanMessage(body),
      new AIMessage({
        content: '好的',
        tool_calls: [{ id: 'call_1', name: 'bash', args: { command: 'ls' } }],
      }),
      new ToolMessage({ content: 'file-a file-b', tool_call_id: 'call_1', name: 'bash' }),
      new AIMessage('完成'),
    ],
  };
}

describe('session store', () => {
  test('newSessionId generates unique UUID v4 ids (Claude Code style)', () => {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(uuidV4);
    expect(b).toMatch(uuidV4);
    expect(a).not.toBe(b);
  });

  test('save + list roundtrips with metadata', () => {
    saveSession(sample('更新 README', '帮我更新这个仓库的 README'));

    const listed = listSessions();
    expect(listed.length).toBe(1);
    expect(listed[0]!.title).toBe('更新 README');
    expect(listed[0]!.model).toBe('deepseek');
  });

  test('messages survive serialization with tool calls intact', () => {
    saveSession(sample('更新 README', '帮我更新 README'));

    const loaded = getSession('ses_test1');
    expect(loaded).toBeDefined();
    const messages = loaded!.messages;
    expect(messages[0]!.getType()).toBe('system');
    expect(messages[1]!.content).toBe('帮我更新 README');
    const ai = messages[2] as AIMessage;
    expect(ai.tool_calls?.[0]?.name).toBe('bash');
    const tool = messages[3] as ToolMessage;
    expect(tool.tool_call_id).toBe('call_1');
    expect(tool.content).toBe('file-a file-b');
  });

  test('search matches titles and message content, case-insensitive', () => {
    saveSession(sample('部署脚本调整', '帮我看看部署'));
    saveSession({ ...sample('无关对话', '今天天气如何'), id: 'ses_test2' });

    const byTitle = searchSessions('部署');
    expect(byTitle.map((s) => s.id)).toEqual(['ses_test1']);

    const byBody = searchSessions('天气');
    expect(byBody.map((s) => s.id)).toEqual(['ses_test2']);
  });

  test('saves each conversation under a per-cwd subdirectory', () => {
    saveSession({ ...sample('分区存储', 'x'), cwd: '/tmp/proj-a' });

    expect(existsSync(path.join(dir, '-tmp-proj-a', 'ses_test1.json'))).toBe(true);
    expect(getSession('ses_test1')?.title).toBe('分区存储');
  });

  test('a Windows cwd is stored under a directory name Windows accepts', () => {
    // A colon in a name is the drive, not a legal part of a directory:
    // "C:-Users-…" makes mkdir fail with ENOENT, so no session could ever be saved.
    saveSession({ ...sample('分区存储', 'x'), cwd: 'C:\\Users\\user\\Downloads\\freeswitch' });

    expect(existsSync(path.join(dir, 'C--Users-user-Downloads-freeswitch', 'ses_test1.json'))).toBe(true);
    expect(getSession('ses_test1')?.cwd).toBe('C:\\Users\\user\\Downloads\\freeswitch');
  });

  test('lists sessions from multiple project directories together', () => {
    saveSession({ ...sample('对话 A', 'a'), id: 'ses_a', cwd: '/tmp/proj-a' });
    saveSession({ ...sample('对话 B', 'b'), id: 'ses_b', cwd: '/tmp/proj-b' });

    expect(listSessions().map((s) => s.id).sort()).toEqual(['ses_a', 'ses_b']);
  });

  test('ignores root-level flat json files (legacy layout unsupported)', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'ses_legacy.json'),
      JSON.stringify({
        id: 'ses_legacy',
        title: '旧格式会话',
        createdAt: 1,
        updatedAt: 1,
        cwd: '/other',
        model: 'deepseek',
        messages: [{ type: 'human', content: 'legacy body' }],
      }),
    );

    expect(listSessions().map((s) => s.id)).not.toContain('ses_legacy');
    expect(getSession('ses_legacy')).toBeUndefined();
  });

  test('failed save leaves the previous session file intact', () => {
    saveSession(sample('旧内容', 'x'));
    const spy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EIO');
    });
    try {
      expect(() => saveSession(sample('新内容', 'y'))).toThrow('EIO');
    } finally {
      spy.mockRestore();
    }

    expect(getSession('ses_test1')?.title).toBe('旧内容');
  });

  test('summary field roundtrips when present, stays absent otherwise', () => {
    saveSession({ ...sample('带提要', 'x'), summary: '旧提要内容' });
    expect(getSession('ses_test1')?.summary).toBe('旧提要内容');

    saveSession({ ...sample('无提要', 'y'), id: 'ses_test2' });
    expect(getSession('ses_test2')?.summary).toBeUndefined();
  });

  test('buildSessionRecord keeps the compaction digest in the persisted record', () => {
    const base = {
      id: 'ses_b1',
      title: '带提要',
      createdAt: 1,
      cwd: '/tmp',
      model: 'deepseek',
      messages: sample('x', 'y').messages,
    };
    const withDigest = buildSessionRecord({ ...base, summary: '前情提要文本' });
    expect(withDigest.summary).toBe('前情提要文本');
    expect(withDigest.updatedAt).toBeGreaterThan(1);

    // Null/undefined digest must not materialize an empty summary field.
    expect(buildSessionRecord({ ...base, summary: null }).summary).toBeUndefined();
    expect(buildSessionRecord(base).summary).toBeUndefined();
  });

  test('list is ordered newest first', () => {
    const older = sample('旧对话', 'a');
    older.createdAt = Date.now() - 10_000;
    older.updatedAt = Date.now() - 10_000;
    older.id = 'ses_old';
    saveSession(older);
    saveSession(sample('新对话', 'b'));

    expect(listSessions()[0]!.id).toBe('ses_test1');
  });
});

describe('slug realpath 等价(清账轮 Important)', () => {
  test('符号链接拼写保存,物理拼写可列出(反之亦然)', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const { mkdtempSync, rmSync } = fs;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tc-slug-'));
    process.env.TRANSCODE_SESSIONS_DIR = path.join(dir, 's');
    try {
      const { saveSession } = await import('./store.js');
      const { listProjectSessions } = await import('./resume.js');
      // macOS tmpdir 是 /var/... 拼法,真实路径 /private/var/...
      const alias = path.join(os.tmpdir(), 'tc-slug-' + path.basename(dir).slice('tc-slug-'.length));
      const physical = await fs.promises.realpath(dir);
      saveSession({ id: 'ses_slug1', title: 't', createdAt: 1, updatedAt: 1, cwd: alias, model: 'm', messages: [] });
      const viaPhysical = await listProjectSessions(physical);
      expect(viaPhysical.some((r) => r.id === 'ses_slug1')).toBe(true);
      const viaAlias = await listProjectSessions(alias);
      expect(viaAlias.some((r) => r.id === 'ses_slug1')).toBe(true);
    } finally {
      delete process.env.TRANSCODE_SESSIONS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
