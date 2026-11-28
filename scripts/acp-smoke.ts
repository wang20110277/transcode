import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
// Keep the smoke session out of the user's real session list.
const sessionsDir = mkdtempSync(path.join(tmpdir(), 'transcode-acp-smoke-'));

interface Frame {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

/** One ACP child process plus a line-framed JSON-RPC client for it. */
class Client {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly notifications: Frame[] = [];

  constructor(private readonly child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf('\n');
        if (!line) continue;

        const frame = JSON.parse(line) as Frame;
        if (frame.method && frame.id !== undefined) {
          // Agent -> client request (session/request_permission in this smoke test).
          if (frame.method === 'session/request_permission') {
            this.write({
              jsonrpc: '2.0',
              id: frame.id,
              result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
            });
          } else {
            this.write({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32601, message: `unhandled ${frame.method}` },
            });
          }
          continue;
        }

        if (frame.method && frame.id === undefined) {
          this.notifications.push(frame);
          continue;
        }

        if (frame.id === undefined) continue;
        const waiter = this.pending.get(Number(frame.id));
        if (!waiter) continue;
        this.pending.delete(Number(frame.id));
        if (frame.error) waiter.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
        else waiter.resolve(frame.result);
      }
    });
  }

  private write(frame: Record<string, unknown>): void {
    this.child.stdin!.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Ends stdin and resolves once the child process has exited. */
  kill(): Promise<void> {
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.stdin!.end();
      setTimeout(() => this.child.kill('SIGTERM'), 200).unref();
    });
  }
}

function spawnClient(): Client {
  const child = spawn(process.execPath, ['bin/transcode.ts', 'acp'], {
    cwd: root,
    env: { ...process.env, TRANSCODE_MOCK: '1', TRANSCODE_SESSIONS_DIR: sessionsDir },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return new Client(child);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const client = spawnClient();
  const init = await client.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'acp-smoke', version: '0.0.0' },
    clientCapabilities: {},
  });
  assert(init.protocolVersion === 1, 'initialize returns protocolVersion 1');
  assert(init.agentInfo?.name === 'transcode', 'initialize identifies transcode');
  assert(init.agentCapabilities?.loadSession === true, 'initialize advertises loadSession');

  const session = await client.request('session/new', { cwd: root, mcpServers: [] });
  assert(typeof session.sessionId === 'string', 'session/new returns a sessionId');

  const first = await client.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'MOCK_TOOL_BASH' }],
  });
  assert(
    first.stopReason === 'end_turn',
    `tool prompt stops with end_turn (got ${JSON.stringify(first)})`,
  );

  const updates = client.notifications
    .filter((frame) => frame.method === 'session/update')
    .map((frame) => frame.params.update);
  assert(
    updates.some((update) => update.sessionUpdate === 'tool_call'),
    'streams a tool_call update',
  );
  assert(
    updates.some((update) => update.sessionUpdate === 'tool_call_update'),
    'streams a tool_call_update update',
  );
  assert(
    updates.some(
      (update) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content?.text?.includes('[mock] tool completed'),
    ),
    'streams the final assistant text',
  );

  const second = await client.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'hello' }],
  });
  assert(second.stopReason === 'end_turn', 'plain prompt stops with end_turn');
  assert(
    client.notifications.some(
      (frame) =>
        frame.method === 'session/update' &&
        frame.params.update?.sessionUpdate === 'agent_message_chunk' &&
        frame.params.update?.content?.text?.includes('[mock] hello'),
    ),
    'plain prompt echoes through the model adapter',
  );

  // --- Restart recovery: kill the process, load the session, continue. ---
  await client.kill();
  const restarted = spawnClient();
  await restarted.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'acp-smoke', version: '0.0.0' },
    clientCapabilities: {},
  });
  const loaded = await restarted.request('session/load', { sessionId: session.sessionId });
  assert(loaded.sessionId === session.sessionId, 'session/load returns the same sessionId');
  const listed = await restarted.request('session/list', { cwd: root });
  assert(
    listed.sessions?.some((entry: any) => entry.sessionId === session.sessionId),
    'session/list includes the persisted session',
  );
  const third = await restarted.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: '重启后继续' }],
  });
  assert(third.stopReason === 'end_turn', 'restarted session answers a prompt');
  const closed = await restarted.request('session/close', { sessionId: session.sessionId });
  assert(closed === null, 'session/close returns null');
  let closeRejected = false;
  try {
    await restarted.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '不应到达' }],
    });
  } catch {
    closeRejected = true;
  }
  assert(closeRejected, 'prompt after close fails with -32002');
  await restarted.kill();

  process.stdout.write('ACP smoke test passed\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });
