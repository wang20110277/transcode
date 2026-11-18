import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * End-to-end ACP test without an external model provider:
 * a local OpenAI-compatible SSE server returns a bash tool call on the first
 * request and a text answer after the tool result.
 */

const root = path.resolve(import.meta.dir, '..');
const port = 17931;

const server = Bun.serve({
  port,
  async fetch(request) {
    if (request.method !== 'POST') return new Response('ok');
    const body = (await request.json()) as { messages?: { role?: string }[] };
    const hasToolResult = body.messages?.some((message) => message.role === 'tool');

    const chunks = hasToolResult
      ? [
          {
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'finished' }, finish_reason: null },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]
      : [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_real_1',
                      type: 'function',
                      function: { name: 'bash', arguments: '{"command":"echo real-tool-ok"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: 'chatcmpl-fake',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'fake-model',
                ...chunk,
              })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  },
});

interface Frame {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

const child = spawn(process.execPath, ['bin/transcode.ts', 'acp'], {
  cwd: root,
  env: {
    ...process.env,
    TRANSCODE_MODEL: 'openai:fake-model',
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    TRANSCODE_PERMISSION_MODE: 'auto',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const updates: any[] = [];

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
  await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'acp-openai-smoke', version: '0' },
    clientCapabilities: {},
  });
  const session = await request('session/new', { cwd: root, mcpServers: [] });
  const result = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'run a tool' }],
  });

  assert(result.stopReason === 'end_turn', `prompt ends with end_turn (got ${JSON.stringify(result)})`);
  assert(
    updates.some((update) => update.sessionUpdate === 'tool_call' && update.name === 'bash'),
    'real OpenAI stream produced a tool_call',
  );
  assert(
    updates.some(
      (update) =>
        update.sessionUpdate === 'tool_call_update' &&
        update.status === 'completed' &&
        JSON.stringify(update).includes('real-tool-ok'),
    ),
    'bash tool actually executed and returned its output',
  );
  assert(
    updates.some(
      (update) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content?.text?.includes('finished'),
    ),
    'model continued after the tool result',
  );

  process.stdout.write('OpenAI-compatible ACP smoke test passed\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    child.stdin.end();
    setTimeout(() => {
      child.kill('SIGTERM');
      server.stop(true);
    }, 200).unref();
  });
