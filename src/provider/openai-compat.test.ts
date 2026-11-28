import { describe, expect, test } from 'bun:test';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import {
  ensureAssistantRoleInSSE,
  serializeToolCallArgsInBody,
  toolCallArgsSafeFetch,
} from './openai-compat.js';

describe('serializeToolCallArgsInBody', () => {
  test('对象 arguments 序列化为字符串(glm 1210 修复)', () => {
    const body = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'assistant', content: 'hi', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'glob', arguments: { pattern: '**/*' } } },
        ] },
      ],
    });
    const fixed = JSON.parse(serializeToolCallArgsInBody(body));
    expect(fixed.messages[0].tool_calls[0].function.arguments).toBe('{"pattern":"**/*"}');
  });

  test('字符串 arguments 原样保留(合规网关零影响)', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'assistant', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"a"}' } },
        ] },
      ],
    });
    expect(JSON.parse(serializeToolCallArgsInBody(body))).toEqual(JSON.parse(body));
  });

  test('非 assistant 消息与其他字段不动;坏 JSON 原样返回', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: { foo: { bar: 1 } } },
        { role: 'assistant', content: '', tool_calls: [] },
      ],
      tools: [{ type: 'function', function: { name: 'x', parameters: { a: 1 } } }],
    });
    expect(JSON.parse(serializeToolCallArgsInBody(body))).toEqual(JSON.parse(body));
    expect(serializeToolCallArgsInBody('not json')).toBe('not json');
  });
});

/** 2026-11-28 真实捕获:glm-5.3-flash 偶发流——delta 无 role,tool_calls 完整。 */
const CAPTURED_ROLELESS_SSE = [
  'data: {"id":"20261128104545f884606964d54faa","created":1795833946,"object":"chat.completion.chunk","model":"glm-5.3-flash","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_f8bc12462f08417ca17155f7","index":0,"type":"function","function":{"name":"read_file","arguments":"{\\"limit\\":100,\\"offset\\":1,\\"path\\":\\"ht/ht-agent/README.md\\"}"}}]}}]}',
  '',
  'data: {"id":"20261128104545f884606964d54faa","created":1795833946,"object":"chat.completion.chunk","model":"glm-5.3-flash","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_9d724f05c8554d31afa8359c","index":1,"type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls -R ht-agent/src\\"}"}}]}}]}',
  '',
  'data: {"id":"20261128104545f884606964d54faa","created":1795833946,"object":"chat.completion.chunk","model":"glm-5.3-flash","choices":[{"index":0,"finish_reason":"tool_calls","delta":{"role":"assistant","content":""}}],"usage":{"prompt_tokens":8444,"completion_tokens":123,"total_tokens":8567,"completion_tokens_details":{"reasoning_tokens":122}}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += new TextDecoder().decode(chunk);
  return out;
}

function dataLinesOf(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      out.push(JSON.parse(line.slice(5)));
    } catch {
      // [DONE] 与坏 JSON 行不参与断言(另行用 includes 验证原样保留)
    }
  }
  return out;
}

describe('ensureAssistantRoleInSSE', () => {
  test('首个无 role 的 delta 注入 assistant;后续无 role 的不再改写', async () => {
    const secondRoleless =
      'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ id: 'c2', index: 1, function: { name: 'bash', arguments: '{}' } }] } }],
      }) +
      '\n\n';
    const out = await collectText(ensureAssistantRoleInSSE(streamOf(CAPTURED_ROLELESS_SSE + secondRoleless)));
    const lines = dataLinesOf(out);
    expect((lines[0] as { choices: [{ delta: { role?: string } }] }).choices[0].delta.role).toBe('assistant');
    // 注入后 role 已确立:后续无 role 的 tool_calls 增量原样保留(交给 defaultRole 学习)
    expect((lines[1] as { choices: [{ delta: { role?: string } }] }).choices[0].delta.role).toBeUndefined();
    // 原本带 role 的收尾块不动
    expect((lines[2] as { choices: [{ delta: { role?: string } }] }).choices[0].delta.role).toBe('assistant');
    expect((lines[3] as { choices: [{ delta: { role?: string } }] }).choices[0].delta.role).toBeUndefined();
  });

  test('首个 delta 自带 role → 全程逐字节透传', async () => {
    const sse = [
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }] }),
      '',
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] }),
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    const out = await collectText(ensureAssistantRoleInSSE(streamOf(sse)));
    expect(out).toBe(sse);
  });

  test('网络分块把 JSON 拆开也能正确注入;[DONE] 与坏 JSON 原样', async () => {
    const out = await collectText(
      ensureAssistantRoleInSSE(
        streamOf('data: {"choices":[{"index":0,"delta":{"tool_', 'calls":[{"id":"c1","index":0,"function":{"name":"read_file","arguments":"{}"}}]}}]}\n', '\ndata: not-json\n\ndata: [DONE]\n\n'),
      ),
    );
    const lines = dataLinesOf(out);
    expect((lines[0] as { choices: [{ delta: { role?: string } }] }).choices[0].delta.role).toBe('assistant');
    expect(out).toContain('data: not-json');
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('toolCallArgsSafeFetch(SSE role 注入)', () => {
  test('event-stream 无 role → 注入且 content-length 剔除;JSON 响应逐字节透传', async () => {
    const json = JSON.stringify({ ok: true });
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/v1/chat/completions') {
          return new Response(CAPTURED_ROLELESS_SSE, {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(json, { headers: { 'content-type': 'application/json' } });
      },
    });
    try {
      const sseRes = await toolCallArgsSafeFetch(`http://localhost:${server.port}/v1/chat/completions`);
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
      expect(sseRes.headers.get('content-length')).toBeNull();
      const text = await sseRes.text();
      const lines = dataLinesOf(text);
      expect((lines[0] as { choices: [{ delta: { role?: string } }] }).choices[0].delta.role).toBe('assistant');
      expect(text).toContain('"name":"read_file"');

      const jsonRes = await toolCallArgsSafeFetch(`http://localhost:${server.port}/other`);
      expect(await jsonRes.text()).toBe(json);
    } finally {
      await server.stop();
    }
  });
});

describe('glm 无 role 流回归(@langchain/openai 消费)', () => {
  test('无 role 的 tool_calls 增量仍被 LangChain 识别(修复前 0 个)', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        await request.text(); // 排空请求体
        return new Response(CAPTURED_ROLELESS_SSE, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    try {
      const model = new ChatOpenAI({
        modelName: 'glm-5.3-flash',
        openAIApiKey: 'test-key',
        temperature: 0,
        configuration: {
          baseURL: `http://localhost:${server.port}/v1`,
          fetch: toolCallArgsSafeFetch,
        },
      });
      const stream = await model.stream([new HumanMessage('看下项目')]);
      let toolChunks = 0;
      const names: string[] = [];
      for await (const chunk of stream) {
        for (const toolCall of chunk.tool_call_chunks ?? []) {
          toolChunks++;
          if (toolCall.name) names.push(toolCall.name);
        }
      }
      expect(toolChunks).toBe(2);
      expect(names).toEqual(['read_file', 'bash']);
    } finally {
      await server.stop();
    }
  });
});

describe('resolveMaxTokens', () => {
  test('未设环境变量 → undefined(不限制,思考模型不被 8192 截断)', async () => {
    const { resolveMaxTokens } = await import('./openai-compat.js');
    delete process.env.TRANSCODE_MAX_TOKENS;
    expect(resolveMaxTokens({})).toBeUndefined();
  });
  test('环境变量设置 → 有限正数', async () => {
    const { resolveMaxTokens } = await import('./openai-compat.js');
    expect(resolveMaxTokens({ TRANSCODE_MAX_TOKENS: '4096' })).toBe(4096);
    expect(resolveMaxTokens({ TRANSCODE_MAX_TOKENS: 'bogus' })).toBeUndefined();
  });
});
