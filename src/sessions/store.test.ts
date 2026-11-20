import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  getSession,
  listSessions,
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
