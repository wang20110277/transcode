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
  return { bindTools: () => runnable } as unknown as BaseChatModel;
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
});
