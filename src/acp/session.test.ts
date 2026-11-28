import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { getSession, type SessionRecord } from '../sessions/store.js';
import { AcpSession, type AcpSessionHost } from './session.js';

const fakeHost: AcpSessionHost = {
  sendUpdate: () => {},
  requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'once' } }),
};

let sessionsDir: string;
let workspace: string;

beforeEach(() => {
  sessionsDir = mkdtempSync(path.join(tmpdir(), 'transcode-acp-sessions-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'transcode-acp-ws-'));
  process.env.TRANSCODE_SESSIONS_DIR = sessionsDir;
  process.env.TRANSCODE_MOCK = '1';
});

afterEach(() => {
  delete process.env.TRANSCODE_SESSIONS_DIR;
  delete process.env.TRANSCODE_MOCK;
  rmSync(sessionsDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function recordFile(session: AcpSession): string {
  const projectDir = workspace.replace(/[\\/:]/g, '-');
  return path.join(sessionsDir, projectDir, `${session.id}.json`);
}

async function round(session: AcpSession, text: string): Promise<void> {
  await session.prompt({ sessionId: session.id, prompt: [{ type: 'text', text }] });
}

describe('AcpSession 持久化', () => {
  test('一轮 prompt 后落盘,文件含标题与消息', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '你好,帮我看看项目');

    const file = recordFile(session);
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord;
    expect(typeof stored.title).toBe('string');
    expect(stored.title.length).toBeGreaterThan(0);
    expect(stored.cwd).toBe(workspace);
    expect(stored.model).toBe('glmc:glm-5.3-flash');
    expect(JSON.stringify(stored.messages)).toContain('你好,帮我看看项目');
  });

  test('tool_calls 消息链往返:persist → fromRecord 不丢 id/args', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '第一轮');
    session.messages.push(
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }],
      }),
      new ToolMessage({ content: 'out', tool_call_id: 'c1', name: 'bash' }),
    );
    session.persist();

    const stored = JSON.parse(readFileSync(recordFile(session), 'utf8'));
    expect(JSON.stringify(stored.messages)).toContain('"tool_calls"');
    expect(JSON.stringify(stored.messages)).toContain('"tool_call_id":"c1"');

    const record = getSession(session.id) as SessionRecord; // 生产同款反序列化路径
    const restored = AcpSession.fromRecord(fakeHost, record);
    const ai = restored.messages.find((m) => m.getType() === 'ai' && (m as AIMessage).tool_calls?.length) as AIMessage;
    expect(ai?.tool_calls?.[0]?.id).toBe('c1');
    expect(ai?.tool_calls?.[0]?.name).toBe('bash');
    const tool = restored.messages.find((m) => m.getType() === 'tool') as ToolMessage;
    expect(tool?.tool_call_id).toBe('c1');
  });

  test('第二轮更新同一文件,消息增长', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '第一轮');
    const file = recordFile(session);
    const first = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord;
    await new Promise((r) => setTimeout(r, 5)); // updatedAt 毫秒分辨
    await round(session, '第二轮');
    const second = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord;

    expect(second.id).toBe(first.id);
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });
});
