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
});
