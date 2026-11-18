import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end ACP test against a real model provider.
 *
 * Requires credentials in the environment (for example ANTHROPIC_AUTH_TOKEN +
 * ANTHROPIC_BASE_URL, or OPENAI_API_KEY). Skips with exit code 0 when no key is
 * configured so it is safe to run in CI.
 */

const root = path.resolve(import.meta.dir, '..');

const hasAnthropic = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
);
const hasOpenai = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);

if (!hasAnthropic && !hasOpenai) {
  process.stdout.write(
    'Skipping real ACP test: set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY\n',
  );
  process.exit(0);
}

interface Frame {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

let buffer = '';
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const updates: any[] = [];
const permissionRequests: any[] = [];

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

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'transcode-acp-'));
await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'This is a smoke-test workspace.\n');

const useInstalled = process.env.TRANSCODE_BIN?.trim();
const child = useInstalled
  ? spawn(useInstalled, ['acp'], {
      cwd: root,
      env: { ...process.env, TRANSCODE_PERMISSION_MODE: 'ask' },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
  : spawn(process.execPath, ['bin/transcode.ts', 'acp'], {
      cwd: root,
      env: { ...process.env, TRANSCODE_PERMISSION_MODE: 'ask' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

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

    if (frame.method === 'session/update') {
      updates.push(frame.params.update);
      continue;
    }

    if (frame.method === 'session/request_permission') {
      permissionRequests.push(frame.params);
      write({
        jsonrpc: '2.0',
        id: frame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      });
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

try {
  await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'acp-real-smoke', version: '0' },
    clientCapabilities: {},
  });

  const session = await request('session/new', { cwd: workspace, mcpServers: [] });
  assert(typeof session.sessionId === 'string', 'session/new returns a sessionId');
  process.stdout.write(`model: ${session.models?.currentModelId}\n`);

  const result = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [
      {
        type: 'text',
        text:
          'Use the bash tool to create a file named proof.txt in the current directory ' +
          'containing exactly "acp-ok" (for example with printf). Then read it back with ' +
          'the read_file tool and reply with the single word DONE.',
      },
    ],
  });

  assert(result.stopReason === 'end_turn', `stopReason is end_turn (got ${JSON.stringify(result)})`);

  const toolCalls = updates.filter((update) => update.sessionUpdate === 'tool_call');
  const text = updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
    .join('');
  process.stdout.write(`assistant text: ${JSON.stringify(text.slice(0, 400))}\n`);
  assert(toolCalls.length > 0, 'the model issued at least one tool call');

  assert(
    updates.some(
      (update) =>
        update.sessionUpdate === 'tool_call_update' && update.status === 'completed',
    ),
    'a tool call completed successfully',
  );

  assert(text.trim().length > 0, 'the model streamed assistant text');
  assert(/DONE/i.test(text), `the model finished with DONE (got ${JSON.stringify(text)})`);

  const proof = await fs.readFile(path.join(workspace, 'proof.txt'), 'utf8').catch(() => '');
  assert(proof.trim() === 'acp-ok', `proof.txt contains acp-ok (got ${JSON.stringify(proof)})`);

  process.stdout.write(`tool calls: ${toolCalls.map((call) => call.name).join(', ')}\n`);
  process.stdout.write(`permission prompts: ${permissionRequests.length}\n`);
  process.stdout.write('Real-model ACP smoke test passed\n');
} catch (error) {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  setTimeout(() => child.kill('SIGTERM'), 200).unref();
}
