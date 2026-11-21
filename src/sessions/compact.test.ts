import { describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { SessionRecord } from './store.js';
import {
  DEFAULT_KEEP_TURNS,
  TRANSCRIPT_LIMIT,
  compressSession,
  parseKeepCount,
  transcriptEntries,
  splitTurns,
} from './compact.js';

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
  test('default keeps only 1 turn', async () => {
    const { compressed, record } = await compressSession(recordWith(3), mockModel('提要内容'));
    expect(compressed).toBe(true);
    expect(record.summary).toBe('提要内容');
    expect(splitTurns(record.messages).turns.length).toBe(DEFAULT_KEEP_TURNS);
    expect(splitTurns(record.messages).turns.length).toBe(1);
    expect(record.messages[0]!.getType()).toBe('system');
    expect(record.updatedAt).toBeGreaterThan(1);
  });

  test('explicit keepTurns=10 keeps 10', async () => {
    const { record } = await compressSession(recordWith(12), mockModel('提要'), 10);
    expect(splitTurns(record.messages).turns.length).toBe(10);
  });

  test('keepTurns below 1 clamps to 1', async () => {
    const { record } = await compressSession(recordWith(3), mockModel('提要'), 0);
    expect(splitTurns(record.messages).turns.length).toBe(1);
  });

  test('at or below keepTurns is a no-op returning the original record', async () => {
    const rec = recordWith(10);
    const { compressed, record } = await compressSession(rec, mockModel('x'), 10);
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
    const { compressed, record, error } = await compressSession(rec, failing, 10);
    expect(compressed).toBe(false);
    expect(error).toBeDefined();
    expect(record).toBe(rec);
  });

  test('empty model reply is treated as failure', async () => {
    const { compressed, error } = await compressSession(recordWith(12), mockModel('   '), 10);
    expect(compressed).toBe(false);
    expect(error).toBeDefined();
  });

  test('rolling merge: previous summary appears in the prompt', async () => {
    const model = mockModel('新提要');
    await compressSession(recordWith(12, { summary: '旧提要内容' }), model, 10);
    expect(model.prompts[0]).toContain('旧提要内容');
  });

  test('huge old transcript is truncated before invoking the model', async () => {
    const model = mockModel('提要');
    await compressSession(recordWith(12, { longTurn: true }), model, 10);
    expect(model.prompts[0]!.length).toBeLessThan(TRANSCRIPT_LIMIT + 2_000);
    expect(model.prompts[0]).toContain('更早内容已截断');
  });
});

describe('parseKeepCount', () => {
  test('undefined → default; "5" → 5; "0"/"abc" → error, no keep', () => {
    expect(parseKeepCount(undefined)).toEqual({});
    expect(parseKeepCount('5')).toEqual({ keep: 5 });
    expect(parseKeepCount('0').keep).toBeUndefined();
    expect(parseKeepCount('0').error).toBeDefined();
    expect(parseKeepCount('abc').error).toBeDefined();
  });
});

describe('transcriptEntries', () => {
  test('digest first, then per-message entries: human→input, ai→output, full content, tool/system skipped', () => {
    const messages: BaseMessage[] = [
      new SystemMessage('sys'),
      new HumanMessage('问题甲'),
      new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'bash', args: {} }] }),
      new ToolMessage({ content: 'out', tool_call_id: 't1', name: 'bash' }),
      new AIMessage('回答'.repeat(200)),
    ];
    const entries = transcriptEntries('前情文本', messages, 3);
    // digest entry
    expect(entries[0]).toEqual({ input: '', output: '📝 前情提要(旧 3 轮)\n前情文本' });
    const rest = entries.slice(1);
    expect(rest).toHaveLength(2);
    expect(rest[0]).toEqual({ input: '问题甲', output: '' });
    expect(rest[1]).toEqual({ input: '', output: '回答'.repeat(200) });
  });

  test('null summary yields turn entries only, no digest', () => {
    const entries = transcriptEntries(null, turn(1, '正文'));
    expect(entries).toEqual([
      { input: '问题1:正文', output: '' },
      { input: '', output: '回答1:正文' },
    ]);
  });
});
