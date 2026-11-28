import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { JsonRpcTransport } from './transport.js';
import { AcpServer } from './server.js';

interface Frame {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

let sessionsDir: string;
let workspaceA: string;
let workspaceB: string;

beforeEach(() => {
  sessionsDir = mkdtempSync(path.join(tmpdir(), 'transcode-acp-srv-sessions-'));
  workspaceA = mkdtempSync(path.join(tmpdir(), 'transcode-acp-srv-a-'));
  workspaceB = mkdtempSync(path.join(tmpdir(), 'transcode-acp-srv-b-'));
  process.env.TRANSCODE_SESSIONS_DIR = sessionsDir;
  process.env.TRANSCODE_MOCK = '1';
});

afterEach(() => {
  delete process.env.TRANSCODE_SESSIONS_DIR;
  delete process.env.TRANSCODE_MOCK;
  rmSync(sessionsDir, { recursive: true, force: true });
  rmSync(workspaceA, { recursive: true, force: true });
  rmSync(workspaceB, { recursive: true, force: true });
});

/** 内存 JSON-RPC 客户端:写行到 input,按 id 配对读 output。 */
function makeServer(): {
  call: (method: string, params?: unknown) => Promise<Frame>;
  outputText: () => string;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  new AcpServer(new JsonRpcTransport(input, output));

  let buffer = '';
  let allOutput = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (frame: Frame) => void }>();
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    allOutput += chunk;
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      const frame = JSON.parse(line) as Frame;
      if (frame.id !== undefined && pending.has(frame.id)) {
        pending.get(frame.id)!.resolve(frame);
        pending.delete(frame.id);
      }
    }
  });

  return {
    call(method: string, params: unknown = {}) {
      const id = nextId++;
      const promise = new Promise<Frame>((resolve) => pending.set(id, { resolve }));
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return promise;
    },
    outputText: () => allOutput,
  };
}

describe('session/list 与 session/close', () => {
  test('list 只出本项目且新→旧', async () => {
    const server = makeServer();
    const older = (await server.call('session/new', { cwd: workspaceA })).result as {
      sessionId: string;
    };
    await server.call('session/prompt', {
      sessionId: older.sessionId,
      prompt: [{ type: 'text', text: '旧会话' }],
    });
    await new Promise((r) => setTimeout(r, 5));
    const newer = (await server.call('session/new', { cwd: workspaceA })).result as {
      sessionId: string;
    };
    await server.call('session/prompt', {
      sessionId: newer.sessionId,
      prompt: [{ type: 'text', text: '新会话' }],
    });
    const other = (await server.call('session/new', { cwd: workspaceB })).result as {
      sessionId: string;
    };
    await server.call('session/prompt', {
      sessionId: other.sessionId,
      prompt: [{ type: 'text', text: '别的项目' }],
    });

    const frame = await server.call('session/list', { cwd: workspaceA });
    const sessions = (frame.result as { sessions: Array<{ sessionId: string; title: string; updatedAt: number }> })
      .sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.sessionId).toBe(newer.sessionId);
    expect(sessions[1]!.sessionId).toBe(older.sessionId);
    expect(typeof sessions[0]!.title).toBe('string');
    expect(sessions[0]!.updatedAt).toBeGreaterThan(0);
  });

  test('close 后 prompt 报 -32002,load 仍可拉起', async () => {
    const server = makeServer();
    const created = (await server.call('session/new', { cwd: workspaceA })).result as {
      sessionId: string;
    };
    await server.call('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '第一轮' }],
    });

    const closed = await server.call('session/close', { sessionId: created.sessionId });
    expect(closed.error).toBeUndefined();

    const prompted = await server.call('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '不该成功' }],
    });
    expect(prompted.error?.code).toBe(-32002);

    const reloaded = await server.call('session/load', { sessionId: created.sessionId });
    expect((reloaded.result as { sessionId: string }).sessionId).toBe(created.sessionId);
  });
});

describe('session/new 模型校验与 error: stderr 约定', () => {
  test('无效 model → invalidParams + error: 行只进 stderr', async () => {
    const server = makeServer();
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const frame = await server.call('session/new', { cwd: workspaceA, model: 'glmz:x' });
      expect(frame.error?.code).toBe(-32602);
      expect(frame.error?.message).toContain('invalid model id');
      expect(
        writes.some((line) => line.startsWith('error: ') && line.includes('invalid model id')),
      ).toBe(true);
      // stdout 是 JSON-RPC 通道,error: 行不得污染
      expect(server.outputText()).not.toContain('error:');
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
    }
  });

  test('空白 model 视为未提供;合法 spec 照常创建', async () => {
    const server = makeServer();
    const blank = await server.call('session/new', { cwd: workspaceA, model: '  ' });
    expect((blank.result as { sessionId?: string }).sessionId).toBeTruthy();
    const ok = await server.call('session/new', { cwd: workspaceA, model: 'glmc:glm-5.3-flash' });
    expect((ok.result as { sessionId?: string }).sessionId).toBeTruthy();
  });
});

describe('session/load 走磁盘', () => {
  test('initialize 声明 loadSession: true', async () => {
    const server = makeServer();
    const frame = await server.call('initialize');
    const caps = frame.result as { agentCapabilities: { loadSession: boolean } };
    expect(caps.agentCapabilities.loadSession).toBe(true);
  });

  test('跨"进程"恢复:重启后 load 同 id 续问', async () => {
    const first = makeServer();
    const created = (await first.call('session/new', { cwd: workspaceA })).result as {
      sessionId: string;
    };
    await first.call('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '第一轮' }],
    });
    // 模拟进程退出:丢弃 first,全新 server/transport,同一 sessions 目录
    const second = makeServer();
    const loaded = await second.call('session/load', { sessionId: created.sessionId });
    expect(((loaded.result as { sessionId: string }).sessionId)).toBe(created.sessionId);

    const continued = await second.call('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '第二轮' }],
    });
    expect((continued.result as { stopReason: string }).stopReason).toBe('end_turn');
  });

  test('未知 id → -32002', async () => {
    const server = makeServer();
    const frame = await server.call('session/load', { sessionId: 'ses_does-not-exist' });
    expect(frame.error?.code).toBe(-32002);
  });

  test('磁盘 JSON 损坏 → -32002 不崩', async () => {
    const first = makeServer();
    const created = (await first.call('session/new', { cwd: workspaceA })).result as {
      sessionId: string;
    };
    await first.call('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '第一轮' }],
    });

    const projectDir = workspaceA.replace(/[\\/:]/g, '-');
    writeFileSync(path.join(sessionsDir, projectDir, `${created.sessionId}.json`), '{broken');

    const second = makeServer();
    const frame = await second.call('session/resume', { sessionId: created.sessionId });
    expect(frame.error?.code).toBe(-32002);
  });
});
