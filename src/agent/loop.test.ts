import { describe, expect, test } from 'bun:test';
import { AIMessageChunk } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentEvent } from './loop.js';
import { runAgentLoop } from './loop.js';
import type { AgentTool } from './tools/index.js';

/** Streams one tool call on the first turn, plain text afterwards. */
function stubModel(): BaseChatModel {
  let calls = 0;
  const runnable = {
    async stream(): Promise<AsyncIterable<{ content: unknown; tool_call_chunks?: unknown[] }>> {
      calls++;
      const chunks =
        calls === 1
          ? [
              new AIMessageChunk({
                content: '',
                tool_call_chunks: [{ id: 'call_1', name: 'fake', args: '{}', index: 0 }],
              }),
            ]
          : [new AIMessageChunk({ content: 'done' })];
      return (async function* () {
        yield* chunks;
      })();
    },
  };
  return { bindTools: () => runnable } as unknown as BaseChatModel;
}

type ScriptStep = { tool: string; args?: string } | { text: string };

/** Replays a scripted sequence: one step per stream call, then ends. */
function scriptedModel(steps: ScriptStep[]): BaseChatModel {
  let calls = 0;
  const runnable = {
    async stream(): Promise<AsyncIterable<{ content: unknown; tool_call_chunks?: unknown[] }>> {
      const step = steps[calls++] ?? { text: 'done' };
      const chunk =
        'tool' in step
          ? new AIMessageChunk({
              content: '',
              tool_call_chunks: [
                { id: `call_${calls}`, name: step.tool, args: step.args ?? '{}', index: 0 },
              ],
            })
          : new AIMessageChunk({ content: step.text });
      return (async function* () {
        yield chunk;
      })();
    },
  };
  const model = {
    bindTools: () => runnable,
    invoke: async () => ({ content: '摘要：任务是更新 README，已完成探索，接下来写入。' }),
  };
  return model as unknown as BaseChatModel;
}

const fakeTool: AgentTool = {
  name: 'fake',
  description: 'test double',
  schema: (await import('zod')).z.object({}),
  kind: 'other',
  isMutating: true,
  title: () => 'fake',
  async execute() {
    return { output: 'ok', diff: '+added-line' };
  },
};

describe('runAgentLoop', () => {
  test('tool_result events carry the diff produced by the tool', async () => {
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      model: stubModel(),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.stopReason).toBe('end_turn');
    const toolResult = events.find((event) => event.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult && toolResult.type === 'tool_result' ? toolResult.diff : undefined).toBe(
      '+added-line',
    );
  });

  test('read-only mutating tools skip the permission request', async () => {
    const events: AgentEvent[] = [];
    let permissionAsked = 0;
    const readOnlyTool: AgentTool = {
      ...fakeTool,
      name: 'fake',
      isMutating: true,
      isReadOnly: () => true,
    };

    const result = await runAgentLoop({
      model: stubModel(),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [readOnlyTool],
      onEvent: (event) => {
        events.push(event);
      },
      requestPermission: async () => {
        permissionAsked++;
        return true;
      },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(permissionAsked).toBe(0);
    const toolResult = events.find((event) => event.type === 'tool_result');
    expect(toolResult && toolResult.type === 'tool_result' ? toolResult.skippedPermission : false)
      .toBe(true);
  });

  test('tool images flow into the ToolMessage as multimodal blocks', async () => {
    const imageTool: AgentTool = {
      ...fakeTool,
      async execute() {
        return {
          output: 'here is the screenshot',
          images: [{ data: 'aW1hZ2U=', mediaType: 'image/png' }],
        };
      },
    };

    const result = await runAgentLoop({
      model: stubModel(),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [imageTool],
      onEvent: () => {},
    });

    const toolMessage = result.messages.find((message) => message.getType() === 'tool');
    const content = toolMessage?.content as unknown;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{ type: string; image_url?: { url: string } }>;
    expect(blocks.some((block) => block.type === 'text')).toBe(true);
    const image = blocks.find((block) => block.type === 'image_url');
    expect(image?.image_url?.url).toBe('data:image/png;base64,aW1hZ2U=');
  });

  test('images are auto-described through the vision proxy when provided', async () => {
    const imageTool: AgentTool = {
      ...fakeTool,
      async execute() {
        return {
          output: 'screenshot captured',
          images: [{ data: 'aW1n', mediaType: 'image/png' }],
        };
      },
    };

    const result = await runAgentLoop({
      model: stubModel(),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [imageTool],
      onEvent: () => {},
      describeImages: async () => '截图显示 429 余额不足报错',
    });

    const toolMessage = result.messages.find((message) => message.getType() === 'tool');
    expect(Array.isArray(toolMessage?.content)).toBe(false);
    expect(String(toolMessage?.content)).toContain('截图显示 429 余额不足报错');
  });

  test('vision proxy failure falls back to raw image blocks', async () => {
    const imageTool: AgentTool = {
      ...fakeTool,
      async execute() {
        return {
          output: 'screenshot captured',
          images: [{ data: 'aW1n', mediaType: 'image/png' }],
        };
      },
    };

    const result = await runAgentLoop({
      model: stubModel(),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [imageTool],
      onEvent: () => {},
      describeImages: async () => {
        throw new Error('vision model offline');
      },
    });

    const toolMessage = result.messages.find((message) => message.getType() === 'tool');
    const content = toolMessage?.content as Array<{ type: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[1]?.type).toBe('image_url');
  });

  test('auto-compacts the conversation when the char budget is exceeded', async () => {
    // Migrated from TRANSCODE_COMPACT_CHARS: budget now arrives via options.
    const events: AgentEvent[] = [];
    const chatty: AgentTool = {
      ...fakeTool,
      isMutating: false,
      async execute() {
        return `large chunk ${'x'.repeat(400)} done`;
      },
    };

    const result = await runAgentLoop({
      model: scriptedModel(
        Array.from({ length: 10 }, (_, i) => ({ tool: 'fake' as const, args: JSON.stringify({ n: i }) })),
      ),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      contextTokens: 300, // ~1200 chars folded, now explicit tokens
      tools: [chatty],
      onEvent: (event) => events.push(event),
    });

    const text = events
      .filter((event) => event.type === 'text')
      .map((event) => (event as { text: string }).text)
      .join('');
    expect(text).toContain('自动压缩');
    expect(
      result.messages.some((message) =>
        message.content.toString().includes('[conversation summary]'),
      ),
    ).toBe(true);
    // The compacted history must not start with an orphaned tool message.
    expect(result.messages[1]?.getType()).not.toBe('tool');
  });

  test('未传 contextTokens → 轮内闸跳过(env 不再直读)', async () => {
    const events: AgentEvent[] = [];
    const chatty: AgentTool = {
      ...fakeTool,
      isMutating: false,
      async execute() {
        return `large chunk ${'x'.repeat(400)} done`;
      },
    };
    const result = await runAgentLoop({
      model: scriptedModel(
        Array.from({ length: 10 }, (_, i) => ({ tool: 'fake' as const, args: JSON.stringify({ n: i }) })),
      ),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [chatty],
      onEvent: (event) => events.push(event),
    });
    const text = events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('');
    expect(text).not.toContain('自动压缩');
    expect(result.messages.length).toBeGreaterThan(5);
  });

  test('plan mode denies mutations and allows read-only exploration', async () => {
    let writes = 0;
    let reads = 0;
    const tools: AgentTool[] = [
      {
        ...fakeTool,
        name: 'write_file',
        isMutating: true,
        async execute() {
          writes++;
          return 'written';
        },
      },
      {
        ...fakeTool,
        name: 'read_file',
        isMutating: false,
        async execute() {
          reads++;
          return 'content';
        },
      },
    ];

    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      model: scriptedModel([
        { tool: 'read_file', args: '{"path":"a"}' },
        { tool: 'write_file', args: '{"path":"a"}' },
      ]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools,
      planMode: true,
      onEvent: (event) => events.push(event),
    });

    expect(result.stopReason).toBe('end_turn');
    expect(reads).toBe(1);
    expect(writes).toBe(0);
    const denied = events.find(
      (event) => event.type === 'tool_result' && event.output.includes('Plan mode'),
    );
    expect(denied).toBeDefined();
  });

  test('mutating tools without isReadOnly still request permission', async () => {
    let permissionAsked = 0;
    await runAgentLoop({
      model: stubModel(),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      onEvent: () => {},
      requestPermission: async () => {
        permissionAsked++;
        return true;
      },
    });
    expect(permissionAsked).toBe(1);
  });

  test('blocks the third consecutive identical call and guides the model', async () => {
    let executions = 0;
    const countingTool: AgentTool = {
      ...fakeTool,
      async execute() {
        executions++;
        return 'ok';
      },
    };
    const events: AgentEvent[] = [];

    const result = await runAgentLoop({
      model: scriptedModel([
        { tool: 'fake', args: '{"a":1}' },
        { tool: 'fake', args: '{"a":1}' },
        { tool: 'fake', args: '{"a":1}' },
        { tool: 'fake', args: '{"a":1}' },
      ]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [countingTool],
      onEvent: (event) => events.push(event),
    });

    expect(result.stopReason).toBe('end_turn');
    expect(executions).toBe(2);
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.length).toBe(4);
    const blocked = results[2];
    expect(blocked && blocked.type === 'tool_result' ? blocked.ok : true).toBe(false);
    expect(blocked && blocked.type === 'tool_result' ? blocked.output : '').toMatch(
      /already executed/i,
    );
  });

  test('a different call resets the repetition counter', async () => {
    let executions = 0;
    const countingTool: AgentTool = {
      ...fakeTool,
      async execute() {
        executions++;
        return 'ok';
      },
    };

    await runAgentLoop({
      model: scriptedModel([
        { tool: 'fake', args: '{"a":1}' },
        { tool: 'fake', args: '{"a":1}' },
        { tool: 'fake', args: '{"a":2}' },
        { tool: 'fake', args: '{"a":1}' },
      ]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [countingTool],
      onEvent: () => {},
    });

    // Windowed rule: the trailing call is the third {"a":1} within the last
    // 6 calls, so it is blocked even though the calls were not consecutive.
    expect(executions).toBe(3);
  });

  test('alternating A-B-A-B loops are blocked by the windowed counter', async () => {
    let aRuns = 0;
    let bRuns = 0;
    const tools: AgentTool[] = [
      {
        ...fakeTool,
        name: 'A',
        async execute() {
          aRuns++;
          return 'ok';
        },
      },
      {
        ...fakeTool,
        name: 'B',
        async execute() {
          bRuns++;
          return 'ok';
        },
      },
    ];

    await runAgentLoop({
      model: scriptedModel([
        { tool: 'A' },
        { tool: 'B' },
        { tool: 'A' },
        { tool: 'B' },
        { tool: 'A' },
      ]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools,
      onEvent: () => {},
    });

    // A appears 3 times within the window → blocked on its third call.
    expect(aRuns).toBe(2);
    expect(bRuns).toBe(2);
  });

  test('hitting the turn cap is loud: event, notice message, stop reason', async () => {
    const events: AgentEvent[] = [];
    const infiniteTools = scriptedModel(
      Array.from({ length: 20 }, () => ({ tool: 'fake' as const, args: '{"a":1}' })),
    );

    const result = await runAgentLoop({
      model: infiniteTools,
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      maxTurns: 2,
      onEvent: (event) => events.push(event),
    });

    expect(result.stopReason).toBe('max_turn_requests');
    expect(events.some((event) => event.type === 'max_turns_reached')).toBe(true);
    const notice = result.messages.find(
      (message) => message.getType() === 'ai' && message.content.toString().includes('maximum number of turns'),
    );
    expect(notice).toBeDefined();
  });

  test('TRANSCODE_MAX_TURNS overrides the default cap', async () => {
    process.env.TRANSCODE_MAX_TURNS = '3';
    try {
      const events: AgentEvent[] = [];
      const infiniteTools = scriptedModel(
        Array.from({ length: 20 }, () => ({ tool: 'fake' as const, args: '{"a":1}' })),
      );

      const result = await runAgentLoop({
        model: infiniteTools,
        cwd: '/tmp',
        messages: [],
        systemPrompt: 'test',
        tools: [fakeTool],
        onEvent: (event) => events.push(event),
      });

      expect(result.stopReason).toBe('max_turn_requests');
      // Circuit breaker blocks execution from the 3rd identical call, but
      // every turn still emits a tool_result event.
      expect(events.filter((event) => event.type === 'tool_result').length).toBe(3);
    } finally {
      delete process.env.TRANSCODE_MAX_TURNS;
    }
  });

  test('nudges the model after prolonged exploration without any mutation', async () => {
    // read-only tool (isMutating false): pure exploration, never "acts".
    const exploreTool: AgentTool = {
      ...fakeTool,
      isMutating: false,
      async execute() {
        return 'ok';
      },
    };
    // Vary args each call so the circuit breaker does not fire.
    const steps = Array.from({ length: 40 }, (_, i) => ({
      tool: 'fake' as const,
      args: JSON.stringify({ n: i }),
    }));

    const result = await runAgentLoop({
      model: scriptedModel(steps),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [exploreTool],
      onEvent: () => {},
    });

    const nudge = result.messages.find(
      (message) =>
        message.getType() === 'ai' && message.content.toString().includes('Stop exploring'),
    );
    expect(nudge).toBeDefined();
  });

  test('no exploration nudge when the model acted early', async () => {
    const writer: AgentTool = {
      ...fakeTool,
      isMutating: true,
      async execute() {
        return 'ok';
      },
    };
    // Mutate on call 1, keep exploring afterwards.
    const steps = Array.from({ length: 40 }, (_, i) => ({
      tool: 'fake' as const,
      args: JSON.stringify({ n: i }),
    }));

    const result = await runAgentLoop({
      model: scriptedModel(steps),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [writer],
      onEvent: () => {},
    });

    const nudge = result.messages.find(
      (message) =>
        message.getType() === 'ai' && message.content.toString().includes('Stop exploring'),
    );
    expect(nudge).toBeUndefined();
  });

  test('nudges the model to wrap up when exploring long after a real file write', async () => {
    const reader: AgentTool = {
      ...fakeTool,
      name: 'reader',
      isMutating: false,
      async execute() {
        return 'ok';
      },
    };
    const writeFile: AgentTool = { ...fakeTool, name: 'write_file' };

    const steps: Array<{ tool: string; args: string }> = [
      { tool: 'write_file', args: '{"n":-1}' },
      ...Array.from({ length: 44 }, (_, i) => ({
        tool: 'reader',
        args: JSON.stringify({ n: i }),
      })),
    ];

    const result = await runAgentLoop({
      model: scriptedModel(steps),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [reader, writeFile],
      onEvent: () => {},
    });

    const nudges = result.messages.filter(
      (message) =>
        message.getType() === 'ai' && message.content.toString().includes('reply with a summary'),
    );
    expect(nudges.length).toBe(1);
  });

  test('mutating bash does not count as a delivered file — no wrap-up nudge', async () => {
    const result = await runAgentLoop({
      model: scriptedModel(
        Array.from({ length: 45 }, (_, i) => ({
          tool: 'fake' as const,
          args: JSON.stringify({ n: i }),
        })),
      ),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool], // mutating, but not a file write
      onEvent: () => {},
    });

    const wrapUp = result.messages.find(
      (message) =>
        message.getType() === 'ai' && message.content.toString().includes('reply with a summary'),
    );
    expect(wrapUp).toBeUndefined();
  });

  test('force-stops when the model keeps exploring after an ignored stall nudge', async () => {
    const reader: AgentTool = {
      ...fakeTool,
      isMutating: false,
      async execute() {
        return 'ok';
      },
    };

    const result = await runAgentLoop({
      model: scriptedModel(
        Array.from({ length: 60 }, (_, i) => ({
          tool: 'fake' as const,
          args: JSON.stringify({ n: i }),
        })),
      ),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [reader],
      onEvent: () => {},
    });

    // Stall nudge at 30 calls, grace of 15 more, then a hard stop.
    expect(result.stopReason).toBe('stalled');
    const notice = result.messages.find(
      (message) =>
        message.getType() === 'ai' && message.content.toString().includes('ignored the earlier reminder'),
    );
    expect(notice).toBeDefined();
  });

  test('starting the deliverable during the grace window cancels the hard stop', async () => {
    const reader: AgentTool = {
      ...fakeTool,
      isMutating: false,
      async execute() {
        return 'ok';
      },
    };
    const writeFile: AgentTool = { ...fakeTool, name: 'write_file' };

    // 32 reads (past the nudge), then write, then a few more reads.
    const steps: Array<{ tool: string; args: string }> = [
      ...Array.from({ length: 32 }, (_, i) => ({
        tool: 'fake',
        args: JSON.stringify({ n: i }),
      })),
      { tool: 'write_file', args: '{"content":"x"}' },
      ...Array.from({ length: 10 }, (_, i) => ({
        tool: 'fake',
        args: JSON.stringify({ m: i }),
      })),
    ];

    const result = await runAgentLoop({
      model: scriptedModel(steps),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [reader, writeFile],
      onEvent: () => {},
    });

    expect(result.stopReason).not.toBe('stalled');
  });

  test('a single mutating bash followed by reads does not trigger the wrap-up nudge', async () => {
    const reader: AgentTool = {
      ...fakeTool,
      name: 'reader',
      isMutating: false,
      async execute() {
        return 'ok';
      },
    };
    const bashLike: AgentTool = { ...fakeTool, name: 'bash' }; // mutating, not a file write

    const steps: Array<{ tool: string; args: string }> = [
      { tool: 'bash', args: '{"n":-1}' },
      ...Array.from({ length: 44 }, (_, i) => ({
        tool: 'reader',
        args: JSON.stringify({ n: i }),
      })),
    ];

    const result = await runAgentLoop({
      model: scriptedModel(steps),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [reader, bashLike],
      onEvent: () => {},
    });

    const wrapUp = result.messages.find(
      (message) =>
        message.getType() === 'ai' && message.content.toString().includes('reply with a summary'),
    );
    // Regression: a misjudged "mutating" bash used to falsely announce
    // "the deliverable has already been written" and abort honest work.
    expect(wrapUp).toBeUndefined();
  });
});


describe('malformed tool-call breaker', () => {
  test('isMalformedToolArgs:仅 _raw 键为真,正常/空参数为假', async () => {
    const { isMalformedToolArgs } = await import('./loop.js');
    expect(isMalformedToolArgs({ _raw: '{"broken": tru' })).toBe(true);
    expect(isMalformedToolArgs({ path: 'a.ts' })).toBe(false);
    expect(isMalformedToolArgs({})).toBe(false);
  });

  test('连续 3 次全格式错误 → 第 3 次拒绝执行并停轮(stalled),给出指引', async () => {
    let executions = 0;
    const countingTool: AgentTool = {
      ...fakeTool,
      name: 'fake',
      async execute() {
        executions++;
        return 'ok';
      },
    };
    const events: Array<{ type: string; text?: string }> = [];
    const result = await runAgentLoop({
      model: scriptedModel([
        { tool: 'fake', args: '{"path": "a.ts", "content": "xxx' },
        { tool: 'fake', args: '{"path": "b.ts", "content": "yyy' },
        { tool: 'fake', args: '{"path": "c.ts", "content": "zzz' },
        { tool: 'fake', args: '{"path": "d.ts", "content": "www' },
      ]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [countingTool],
      onEvent: (event) => events.push(event as never),
    });

    expect(result.stopReason).toBe('stalled');
    expect(executions).toBeLessThanOrEqual(2);
    const guidance = events.find(
      (event) => event.type === 'text' && JSON.stringify(event).includes('malformed'),
    );
    expect(guidance).toBeDefined();
  });

  test('格式错误后自愈(第 2 次正常)→ 计数归零不熔断', async () => {
    const events: Array<{ type: string }> = [];
    const result = await runAgentLoop({
      model: scriptedModel([
        { tool: 'fake', args: '{"broken": tru' },
        { tool: 'fake', args: '{"a":1}' },
        { tool: 'fake', args: '{"a":2}' },
        { tool: 'fake', args: '{"a":3}' },
        { tool: 'fake', args: '{"a":4}' },
        { tool: 'text' as never, text: 'done' } as never,
      ]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      onEvent: (event) => events.push(event as never),
    });
    expect(result.stopReason).toBe('end_turn');
  });
});

describe('empty-response recovery', () => {
  test('终轮三无(无文本无工具)→ 同消息重试一次,文本恢复', async () => {
    const events: Array<{ type: string; text?: string }> = [];
    const result = await runAgentLoop({
      model: scriptedModel([
        { tool: 'fake', args: '{"a":1}' },
        { text: '' },            // empty round: provider hiccup (thinking-only stop)
        { text: '最终答案来了。' },  // retry succeeds
      ]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      onEvent: (event) => events.push(event as never),
    });
    expect(result.stopReason).toBe('end_turn');
    const texts = events.filter((e) => e.type === 'text').map((e) => e.text ?? '');
    expect(texts.join('')).toContain('最终答案来了');
  });

  test('重试仍空 → end_turn 且发出可见 ⚠(不再无声丢回复)', async () => {
    const events: Array<{ type: string; text?: string }> = [];
    const result = await runAgentLoop({
      model: scriptedModel([
        { tool: 'fake', args: '{"a":1}' },
        { text: '' },
        { text: '' },
        { text: '' },
      ]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      onEvent: (event) => events.push(event as never),
    });
    expect(result.stopReason).toBe('end_turn');
    const texts = events.filter((e) => e.type === 'text').map((e) => e.text ?? '');
    expect(texts.some((t) => t.includes('重试(第 1/2 轮)'))).toBe(true);
    expect(texts.some((t) => t.includes('重试(第 2/2 轮)'))).toBe(true);
    expect(texts.some((t) => t.includes('连续 3 次'))).toBe(true);
  });

  test('首轮就空(无前序工具轮)→ 不重试直接结束,无 ⚠', async () => {
    const events: Array<{ type: string; text?: string }> = [];
    const result = await runAgentLoop({
      model: scriptedModel([{ text: '' }, { text: '' }]),
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      onEvent: (event) => events.push(event as never),
    });
    expect(result.stopReason).toBe('end_turn');
    expect(events.some((e) => e.type === 'text')).toBe(false);
  });
});

describe('stream-error retry', () => {
  test('流中途断开 → 标注重试,同消息重发后成功', async () => {
    let attempt = 0;
    const flaky = {
      bindTools: () => ({
        async stream() {
          attempt++;
          if (attempt === 1) {
            return (async function* () {
              yield new AIMessageChunk({ content: '半截' });
              throw new Error('fetch failed: connection reset');
            })();
          }
          return (async function* () {
            yield new AIMessageChunk({ content: '完整的回答。' });
          })();
        },
      }),
    };
    const events: Array<{ type: string; text?: string }> = [];
    const result = await runAgentLoop({
      model: flaky as never,
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      onEvent: (event) => events.push(event as never),
    });
    expect(result.stopReason).toBe('end_turn');
    const texts = events.filter((e) => e.type === 'text').map((e) => e.text ?? '');
    expect(texts.some((t) => t.includes('重试(第 1/2 轮)'))).toBe(true);
    expect(texts.join('')).toContain('完整的回答');
    // 半截文本已流出无法收回,但顺序必须是:半截 → 重试标注 → 完整回答
    const joined = texts.join('');
    expect(joined.indexOf('半截')).toBeLessThan(joined.indexOf('连接中断'));
    expect(joined.indexOf('连接中断')).toBeLessThan(joined.indexOf('完整的回答'));
  });

  test('连续断流 2 次 → 第 3 次仍抛则回合失败并 ⚠', async () => {
    let attempt = 0;
    const dead = {
      bindTools: () => ({
        async stream() {
          attempt++;
          throw new Error('always down');
        },
      }),
    };
    const events: Array<{ type: string; text?: string }> = [];
    const result = await runAgentLoop({
      model: dead as never,
      cwd: '/tmp',
      messages: [],
      systemPrompt: 'test',
      tools: [fakeTool],
      onEvent: (event) => events.push(event as never),
    });
    expect(attempt).toBe(3); // 1 + 2 retries
    expect(result.stopReason).toBe('end_turn');
    expect(events.some((e) => e.type === 'text' && (e.text ?? '').includes('⚠'))).toBe(true);
  });
});
