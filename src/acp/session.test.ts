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
  test('persist 保住 summary(REPL /compact 摘要不丢)', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '第一轮');
    const record = getSession(session.id)!;
    record.summary = '早期轮次的摘要 digest';
    const restored = AcpSession.fromRecord(fakeHost, record);
    restored.persist();
    expect(getSession(session.id)?.summary).toBe('早期轮次的摘要 digest');
  });

  test('标题生成不阻塞响应(后台补写)', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '第一轮'); // mock 无 provider,先落盘
    // 手工装一个"永不返回"的模型,模拟慢网关的标题调用
    (session as unknown as { lastProviderModel?: unknown }).lastProviderModel = {
      invoke: () => new Promise(() => {}),
    };
    (session as unknown as { titleGenerated: boolean }).titleGenerated = false;
    await round(session, '第二轮'); // 修复前:finally 内联 await → 挂死超时
    expect(existsSync(recordFile(session))).toBe(true);
  });

  test('close 后的晚到 persist 不再写盘', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '第一轮');
    const before = JSON.parse(readFileSync(recordFile(session), 'utf8')) as SessionRecord;
    session.close();
    await new Promise((r) => setTimeout(r, 5));
    session.persist(); // 孤儿轮的 finally 晚到落盘
    const after = JSON.parse(readFileSync(recordFile(session), 'utf8')) as SessionRecord;
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  test('取消轮的悬空 tool_calls 落盘前补占位 ToolMessage', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '第一轮');
    session.messages.push(
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'bash', args: { command: 'ls' } },
          { id: 'c2', name: 'read_file', args: { path: 'a' } },
        ],
      }),
      new ToolMessage({ content: 'out', tool_call_id: 'c1', name: 'bash' }),
    );
    session.persist();
    const record = getSession(session.id)!;
    const tools = record.messages.filter((m) => m.getType() === 'tool') as ToolMessage[];
    const c2 = tools.find((t) => t.tool_call_id === 'c2');
    expect(c2).toBeDefined();
    expect(String(c2!.content)).toContain('cancelled');
  });

  test('finalizeRound:同步落回退标题,模型标题后台补写', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '帮我看看这个项目');
    let release!: (value: { content: string }) => void;
    const gate = new Promise<{ content: string }>((resolve) => {
      release = resolve;
    });
    const internal = session as unknown as {
      lastProviderModel?: unknown;
      titleGenerated: boolean;
      finalizeRound: () => void;
      titleUpgradeDone?: Promise<void>;
    };
    internal.lastProviderModel = { invoke: () => gate };
    internal.titleGenerated = false;

    internal.finalizeRound(); // 必须立即返回,不等模型
    session.persist();
    const before = JSON.parse(readFileSync(recordFile(session), 'utf8')) as SessionRecord;
    expect(before.title).not.toBe('模型起的标题');

    release({ content: '模型起的标题' });
    await internal.titleUpgradeDone;
    const after = JSON.parse(readFileSync(recordFile(session), 'utf8')) as SessionRecord;
    expect(after.title).toBe('模型起的标题');
  });

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

describe('Minor 清账 E 组', () => {
  test('#18 首轮即失败(无 human)不落垃圾记录', async () => {
    delete process.env.TRANSCODE_MOCK;
    const { writeFileSync: wf } = await import('node:fs');
    const configPath = path.join(sessionsDir, 'cfg.json');
    wf(configPath, JSON.stringify({ profiles: { dead: { baseUrl: 'http://127.0.0.1:9/v1', model: 'x' } } }));
    process.env.TRANSCODE_CONFIG_PATH = configPath;
    try {
      const session = new AcpSession(fakeHost, workspace, 'dead');
      const result = await session.prompt({ sessionId: session.id, prompt: [{ type: 'text', text: 'hi' }] });
      expect(result.stopReason).toBe('refusal');
      expect(existsSync(recordFile(session))).toBe(false);
    } finally {
      process.env.TRANSCODE_MOCK = '1';
      delete process.env.TRANSCODE_CONFIG_PATH;
    }
  });

  test('#17 persist 抛错不卡 busy,下一轮照常', async () => {
    const session = new AcpSession(fakeHost, workspace, 'glmc:glm-5.3-flash');
    await round(session, '第一轮');
    const { chmodSync } = await import('node:fs');
    chmodSync(path.dirname(recordFile(session)), 0o500); // 项目目录只读,写入必炸
    try {
      const result = await session.prompt({ sessionId: session.id, prompt: [{ type: 'text', text: '第二轮' }] });
      expect(result.stopReason).toBe('end_turn');
      const internal = session as unknown as { busy: boolean };
      expect(internal.busy).toBe(false);
    } finally {
      chmodSync(path.dirname(recordFile(session)), 0o700);
    }
  });

  test('#19 fromRecord 钉住空 model,不落 env 回退', async () => {
    process.env.TRANSCODE_MODEL = 'deepseek';
    try {
      const record = { id: 'ses_x', title: 't', createdAt: 1, updatedAt: 1, cwd: workspace, model: '', messages: [] };
      const session = AcpSession.fromRecord(fakeHost, record);
      expect((session as unknown as { modelSpec: string }).modelSpec).toBe('');
    } finally {
      delete process.env.TRANSCODE_MODEL;
    }
  });
});
