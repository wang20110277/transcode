import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentLoopOptions, AgentLoopResult } from '../loop.js';
import { createDispatchAgentTool } from './dispatch.js';
import { readFileTool } from './files.js';
import { globTool } from './search.js';
import { setRouting } from '../../provider/provider.js';
import { createToolSession } from './session.js';

const pool = [readFileTool, globTool];
const runs: AgentLoopOptions[] = [];
const runLoopStub = async (options: AgentLoopOptions): Promise<AgentLoopResult> => {
  runs.push(options);
  return {
    stopReason: 'end_turn',
    messages: [new HumanMessage('task'), new AIMessage('调查结论：风险 A 和 B')],
  };
};
const noopModel = {} as BaseChatModel;

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-dispatch-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  runs.length = 0;
  setRouting('research', 'deepseek');
});
afterEach(() => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  delete process.env.TRANSCODE_SUBAGENT_MAX_TURNS;
  rmSync(configDir, { recursive: true, force: true });
});

function makeTool() {
  return createDispatchAgentTool({ runLoop: runLoopStub, tools: pool, model: noopModel });
}

describe('dispatch_agent', () => {
  test('runs a nested loop for the routed role and returns its final report', async () => {
    const tool = makeTool();
    const session = createToolSession('/tmp');
    const report = await tool.execute(
      { role: 'research', task: '调查鉴权链路' },
      { cwd: '/tmp', session },
    );

    expect(report).toBe('调查结论：风险 A 和 B');
    expect(runs.length).toBe(1);
    const run = runs[0]!;
    expect(run.maxTurns).toBe(25);
    expect(String((run.messages[0] as HumanMessage).content)).toBe('调查鉴权链路');
    expect(run.systemPrompt).toMatch(/sub-?agent|子代理/i);
    expect(run.tools?.map((item) => item.name).sort()).toEqual(['glob', 'read_file']);
  });

  test('is a mutating tool so dispatch requires user authorization', () => {
    const tool = makeTool();
    expect(tool.isMutating).toBe(true);
    expect(tool.isReadOnly?.({ role: 'research', task: 'x' })).toBeFalsy();
  });

  test('unknown role lists the configured roles', async () => {
    const tool = makeTool();
    const session = createToolSession('/tmp');
    await expect(
      tool.execute({ role: 'nope', task: 'x' }, { cwd: '/tmp', session }),
    ).rejects.toThrow(/Unknown role "nope".*research/);
  });

  test('unknown tool names in the whitelist are rejected', async () => {
    const tool = makeTool();
    const session = createToolSession('/tmp');
    await expect(
      tool.execute(
        { role: 'research', task: 'x', tools: ['read_file', 'nuclear_launch'] },
        { cwd: '/tmp', session },
      ),
    ).rejects.toThrow(/nuclear_launch/);
  });

  test('dispatch_agent itself can never be whitelisted (no recursion)', async () => {
    const tool = makeTool();
    const session = createToolSession('/tmp');
    await expect(
      tool.execute(
        { role: 'research', task: 'x', tools: ['dispatch_agent'] },
        { cwd: '/tmp', session },
      ),
    ).rejects.toThrow(/dispatch_agent/);
  });

  test('TRANSCODE_SUBAGENT_MAX_TURNS overrides the turn cap', async () => {
    process.env.TRANSCODE_SUBAGENT_MAX_TURNS = '7';
    const tool = makeTool();
    const session = createToolSession('/tmp');
    await tool.execute({ role: 'research', task: 'x' }, { cwd: '/tmp', session });
    expect(runs[0]!.maxTurns).toBe(7);
  });

  test('forwards sub-agent tool activity to the parent as prefixed events', async () => {
    const emitted: Array<{ name: string; title: string }> = [];
    const tool = createDispatchAgentTool({
      runLoop: async (options) => {
        void options.onEvent?.({
          type: 'tool_call',
          toolCallId: 'sub-1',
          name: 'grep',
          title: 'search: auth',
          kind: 'search',
          input: {},
        });
        void options.onEvent?.({
          type: 'text',
          text: 'should not be forwarded',
        });
        return {
          stopReason: 'end_turn',
          messages: [new HumanMessage('t'), new AIMessage('报告')],
        };
      },
      tools: pool,
      model: noopModel,
    });

    const report = await tool.execute(
      { role: 'research', task: 'x' },
      {
        cwd: '/tmp',
        session: createToolSession('/tmp'),
        emit: (event) => {
          if (event.type === 'tool_call') {
            emitted.push({ name: event.name, title: event.title });
          }
        },
      },
    );

    expect(report).toBe('报告');
    expect(emitted).toEqual([{ name: 'grep', title: '[research] search: auth' }]);
  });

  test('an empty sub-agent report is an error', async () => {
    const tool = createDispatchAgentTool({
      runLoop: async () => ({ stopReason: 'end_turn', messages: [new HumanMessage('t')] }),
      tools: pool,
      model: noopModel,
    });
    const session = createToolSession('/tmp');
    await expect(
      tool.execute({ role: 'research', task: 'x' }, { cwd: '/tmp', session }),
    ).rejects.toThrow(/报告|report/i);
  });
});
