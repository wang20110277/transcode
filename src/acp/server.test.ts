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
  // #29: tests must not read the developer's real ~/.transcode.json —
  // catalog assertions are key-scoped and machine keys would leak in.
  process.env.TRANSCODE_CONFIG_PATH = path.join(sessionsDir, 'config.json');
  process.env.TRANSCODE_SESSIONS_DIR = sessionsDir;
  process.env.TRANSCODE_MOCK = '1';
});

afterEach(() => {
  delete process.env.TRANSCODE_SESSIONS_DIR;
  delete process.env.TRANSCODE_MOCK;
  delete process.env.TRANSCODE_CONFIG_PATH;
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

describe('agent/models', () => {
  test('免初始化直接可用,返回具体规格目录(key 圈定)', async () => {
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ apiKeys: { glmc: 'test-key' } }),
    );
    const server = makeServer();
    const frame = await server.call('agent/models');
    const models = (frame.result as { models: Array<{ modelId: string; name: string }> })
      .models;
    expect(Array.isArray(models)).toBe(true);
    expect(models.some((model) => model.modelId === 'glmc:glm-5.3-flash')).toBe(true);
    expect(models.some((model) => model.modelId === 'glmc')).toBe(false);
    expect(models.every((model) => typeof model.name === 'string')).toBe(true);
  });

  test('session/new 的 availableModels 同为具体规格', async () => {
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ apiKeys: { glmc: 'test-key' } }),
    );
    const server = makeServer();
    const created = (await server.call('session/new', { cwd: workspaceA })).result as {
      sessionId: string;
      models: { availableModels: Array<{ modelId: string }> };
    };
    expect(
      created.models.availableModels.some((model) => model.modelId === 'glmc:glm-5.3-flash'),
    ).toBe(true);
  });

  test('#28 默认模型的 unshift 行显示注册表名而非裸 id', async () => {
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH!,
      JSON.stringify({ apiKeys: { glmc: 'test-key' } }),
    );
    process.env.TRANSCODE_MODEL = 'glmc';
    try {
      const server = makeServer();
      const created = (await server.call('session/new', { cwd: workspaceA })).result as {
        models: { availableModels: Array<{ modelId: string; name: string }> };
      };
      const head = created.models.availableModels[0]!;
      expect(head.modelId).toBe('glmc');
      expect(head.name).toBe('GLM Coding Plan');
    } finally {
      delete process.env.TRANSCODE_MODEL;
    }
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

describe('shutdownNotice', () => {
  test('返回带信号名的一行原因', async () => {
    const { shutdownNotice } = await import('./server.js');
    expect(shutdownNotice('SIGTERM')).toBe('[transcode] SIGTERM: shutting down\n');
    expect(shutdownNotice('SIGINT')).toBe('[transcode] SIGINT: shutting down\n');
  });
});

describe('审查修复:易用性补丁', () => {
  test('set_model 同样校验,无效 id 报 invalidParams', async () => {
    const server = makeServer();
    const created = (await server.call('session/new', { cwd: workspaceA })).result as {
      sessionId: string;
    };
    const bad = await server.call('session/set_model', {
      sessionId: created.sessionId,
      modelId: 'glmz:x',
    });
    expect(bad.error?.code).toBe(-32602);
    const ok = await server.call('session/set_model', {
      sessionId: created.sessionId,
      modelId: 'glmc:glm-5.3-flash',
    });
    expect((ok.result as { models: unknown[] }).models).toBeTruthy();
  });

  test('空模型段(glgc:)在 session/new 即被拒', async () => {
    const server = makeServer();
    const frame = await server.call('session/new', { cwd: workspaceA, model: 'glmc:' });
    expect(frame.error?.code).toBe(-32602);
  });

  test('例行协议未命中不再刷 error: 行', async () => {
    const server = makeServer();
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await server.call('session/load', { sessionId: 'ses_missing' });
      await server.call('no/such-method', {});
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
    }
    expect(writes.some((line) => line.startsWith('error: '))).toBe(false);
  });

  test('prompt 的运行性失败写 error: 行(provider 错误)', async () => {
    delete process.env.TRANSCODE_MOCK; // 需要 createModel/网络路径真跑
    // 确定性失败:profile 指向必拒端口,连接即刻 ECONNREFUSED
    const configPath = path.join(sessionsDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        profiles: { deadgw: { baseUrl: 'http://127.0.0.1:9/v1', model: 'x' } },
      }),
    );
    process.env.TRANSCODE_CONFIG_PATH = configPath;
    const server = makeServer();
    const created = (await server.call('session/new', { cwd: workspaceA, model: 'deadgw' })).result as {
      sessionId: string;
    };
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const frame = await server.call('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect((frame.result as { stopReason: string }).stopReason).toBe('refusal');
      expect(writes.some((line) => line.startsWith('error: '))).toBe(true);
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
      process.env.TRANSCODE_MOCK = '1';
      delete process.env.TRANSCODE_CONFIG_PATH;
    }
  });
});
