import { describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { SessionRecord } from './store.js';
import { KEEP_TURNS, TRANSCRIPT_LIMIT, compressSession, renderTranscript, splitTurns } from './compact.js';

function turn(n: number, text = 'x'): BaseMessage[] {
  return [new HumanMessage(`问题${n}:${text}`), new AIMessage(`回答${n}:${text}`)];
}

function recordWith(turns: number, opts: { summary?: string; longTurn?: boolean } = {}): SessionRecord {
  const messages: BaseMessage[] = [new SystemMessage('system prompt')];
  for (let i = 1; i <= turns; i++) {
    messages.push(...turn(i, opts.longTurn ? '长'.repeat(20_000) : '正文'));
  }
  return {
    id: 'ses_c1',
    title: '压缩测试',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp/proj',
    model: 'deepseek',
    messages,
    ...(opts.summary ? { summary: opts.summary } : {}),
  };
}

function mockModel(text: string): { invoke: (input: string) => Promise<{ content: string }>; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    invoke: async (input: string) => {
      prompts.push(input);
      return { content: text };
    },
  };
}

describe('splitTurns', () => {
  test('leading system messages are not a turn; tool/AI messages attach to their human turn', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('sys'),
      new HumanMessage('a'),
      new AIMessage({ content: '思考', tool_calls: [{ id: 't1', name: 'bash', args: { command: 'ls' } }] }),
      new ToolMessage({ content: 'out', tool_call_id: 't1', name: 'bash' }),
      new AIMessage('答a'),
      new HumanMessage('b'),
      new AIMessage('答b'),
    ];
    const { leading, turns } = splitTurns(msgs);
    expect(leading.map((m) => m.getType())).toEqual(['system']);
    expect(turns.length).toBe(2);
    expect(turns[0]!.map((m) => m.getType())).toEqual(['human', 'ai', 'tool', 'ai']);
    expect(turns[1]!.map((m) => m.getType())).toEqual(['human', 'ai']);
  });
});

describe('compressSession', () => {
  test('more than KEEP_TURNS: trims to window, sets summary, keeps leading, bumps updatedAt', async () => {
    const { compressed, record } = await compressSession(recordWith(12), mockModel('提要内容'));
    expect(compressed).toBe(true);
    expect(record.summary).toBe('提要内容');
    expect(splitTurns(record.messages).turns.length).toBe(KEEP_TURNS);
    expect(record.messages[0]!.getType()).toBe('system');
    expect(record.updatedAt).toBeGreaterThan(1);
  });

  test('at or below KEEP_TURNS is a no-op returning the original record', async () => {
    const rec = recordWith(KEEP_TURNS);
    const { compressed, record } = await compressSession(rec, mockModel('x'));
    expect(compressed).toBe(false);
    expect(record).toBe(rec);
  });

  test('model failure returns original record with error', async () => {
    const rec = recordWith(12);
    const failing = {
      invoke: async () => {
        throw new Error('API down');
      },
    };
    const { compressed, record, error } = await compressSession(rec, failing);
    expect(compressed).toBe(false);
    expect(error).toBeDefined();
    expect(record).toBe(rec);
  });

  test('empty model reply is treated as failure', async () => {
    const { compressed, error } = await compressSession(recordWith(12), mockModel('   '));
    expect(compressed).toBe(false);
    expect(error).toBeDefined();
  });

  test('rolling merge: previous summary appears in the prompt', async () => {
    const model = mockModel('新提要');
    await compressSession(recordWith(12, { summary: '旧提要内容' }), model);
    expect(model.prompts[0]).toContain('旧提要内容');
  });

  test('huge old transcript is truncated before invoking the model', async () => {
    const model = mockModel('提要');
    await compressSession(recordWith(12, { longTurn: true }), model);
    expect(model.prompts[0]!.length).toBeLessThan(TRANSCRIPT_LIMIT + 2_000);
    expect(model.prompts[0]).toContain('更早内容已截断');
  });
});

describe('renderTranscript', () => {
  test('renders summary block plus human/ai pairs, skipping tool/system, capping line length', () => {
    const messages: BaseMessage[] = [
      new SystemMessage('sys'),
      new HumanMessage('问题甲'),
      new AIMessage({ content: '调用', tool_calls: [{ id: 't1', name: 'bash', args: {} }] }),
      new ToolMessage({ content: 'out', tool_call_id: 't1', name: 'bash' }),
      new AIMessage('回答'.repeat(100)),
    ];
    const out = renderTranscript('前情文本', messages);
    expect(out).toContain('前情提要');
    expect(out).toContain('前情文本');
    expect(out).toContain('你: 问题甲');
    expect(out).toContain('AI:');
    expect(out).not.toContain('工具');
    const longest = Math.max(...out.split('\n').map((l) => l.length));
    expect(longest).toBeLessThanOrEqual(140);
  });

  test('null summary renders turns only', () => {
    const out = renderTranscript(null, turn(1, '正文'));
    expect(out).not.toContain('前情提要');
    expect(out).toContain('你: 问题1:正文');
    expect(out).toContain('AI: 回答1:正文');
  });
});
