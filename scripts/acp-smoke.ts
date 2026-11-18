import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');

interface Frame {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

const child = spawn(process.execPath, ['bin/transcode.ts', 'acp'], {
  cwd: root,
  env: { ...process.env, TRANSCODE_MOCK: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const notifications: Frame[] = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;

    const frame = JSON.parse(line) as Frame;
    if (frame.method && frame.id !== undefined) {
      // Agent -> client request (session/request_permission in this smoke test).
      if (frame.method === 'session/request_permission') {
        write({
          jsonrpc: '2.0',
          id: frame.id,
          result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
        });
      } else {
        write({
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32601, message: `unhandled ${frame.method}` },
        });
      }
      continue;
    }

    if (frame.method && frame.id === undefined) {
      notifications.push(frame);
      continue;
    }

    if (frame.id === undefined) continue;
    const waiter = pending.get(Number(frame.id));
    if (!waiter) continue;
    pending.delete(Number(frame.id));
    if (frame.error) waiter.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
    else waiter.resolve(frame.result);
  }
});

function write(frame: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ jsonrpc: '2.0', id, method, params });
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'acp-smoke', version: '0.0.0' },
    clientCapabilities: {},
  });
  assert(init.protocolVersion === 1, 'initialize returns protocolVersion 1');
  assert(init.agentInfo?.name === 'transcode', 'initialize identifies transcode');

  const session = await request('session/new', { cwd: root, mcpServers: [] });
  assert(typeof session.sessionId === 'string', 'session/new returns a sessionId');

  const first = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'MOCK_TOOL_BASH' }],
  });
  assert(
    first.stopReason === 'end_turn',
    `tool prompt stops with end_turn (got ${JSON.stringify(first)})`,
  );

  const updates = notifications
    .filter((frame) => frame.method === 'session/update')
    .map((frame) => frame.params.update);
  assert(
    updates.some((update) => update.sessionUpdate === 'tool_call'),
    'streams a tool_call update',
  );
  assert(
    updates.some((update) => update.sessionUpdate === 'tool_call_update'),
    'streams a tool_call_update',
  );
  assert(
    updates.some(
      (update) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content?.text?.includes('[mock] tool completed'),
    ),
    'streams the final assistant text',
  );

  const second = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'hello' }],
  });
  assert(second.stopReason === 'end_turn', 'plain prompt stops with end_turn');
  assert(
    notifications.some(
      (frame) =>
        frame.method === 'session/update' &&
        frame.params.update?.sessionUpdate === 'agent_message_chunk' &&
        frame.params.update?.content?.text?.includes('[mock] hello'),
    ),
    'plain prompt echoes through the model adapter',
  );

  process.stdout.write('ACP smoke test passed\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    child.stdin.end();
    setTimeout(() => child.kill('SIGTERM'), 200).unref();
  });
