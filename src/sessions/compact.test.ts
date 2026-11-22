import { describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { SessionRecord } from './store.js';
import {
  COMPACT_MAX_SUMMARY_CHARS,
  DEFAULT_KEEP_TURNS,
  TRANSCRIPT_LIMIT,
  compressSession,
  estimateTokens,
  parseKeepCount,
  shouldAutoCompact,
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

/** Streaming mock: yields chunks; can throw at chunk N and track pulls. */
function streamModel(
  chunks: string[],
  opts: { throwAt?: number; trackPulled?: string[] } = {},
): { stream: (input: string) => AsyncGenerator<{ content: string }>; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    stream: async function* (input: string) {
      prompts.push(input);
      for (let i = 0; i < chunks.length; i++) {
        opts.trackPulled?.push(chunks[i]!);
        if (opts.throwAt === i + 1) throw new Error('stream blew up');
        yield { content: chunks[i]! };
      }
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
  test('streams chunks into the summary and forwards each delta', async () => {
    const deltas: string[] = [];
    const { compressed, record } = await compressSession(
      recordWith(3),
      streamModel(['前情', '提要']),
      1,
      (d) => deltas.push(d),
    );
    expect(compressed).toBe(true);
    expect(record.summary).toBe('前情提要');
    expect(deltas).toEqual(['前情', '提要']);
  });

  test('caps summary at COMPACT_MAX_SUMMARY_CHARS and stops consuming early', async () => {
    const pulled: string[] = [];
    const model = streamModel(['x'.repeat(1000), 'y'.repeat(1000), 'z'.repeat(1000)], { trackPulled: pulled });
    const { record } = await compressSession(recordWith(3), model, 1);
    expect(record.summary!.length).toBeLessThanOrEqual(COMPACT_MAX_SUMMARY_CHARS);
    expect(pulled.length).toBe(2); // 第三块未消费
  });

  test('mid-stream error falls back with error set', async () => {
    const rec = recordWith(3);
    const { compressed, record, error } = await compressSession(rec, streamModel(['前情', '提要'], { throwAt: 2 }), 1);
    expect(compressed).toBe(false);
    expect(error).toBeDefined();
    expect(record).toBe(rec);
  });

  test('non-string chunk content is skipped', async () => {
    const model = {
      stream: async function* () {
        yield { content: '前情' };
        yield { content: [{ text: 'x' }] };
        yield { content: '提要' };
      },
    };
    const { record } = await compressSession(recordWith(3), model as never, 1);
    expect(record.summary).toBe('前情提要');
  });

  test('default keeps only 1 turn', async () => {
    const { compressed, record } = await compressSession(recordWith(3), streamModel(['提要内容']));
    expect(compressed).toBe(true);
    expect(record.summary).toBe('提要内容');
    expect(splitTurns(record.messages).turns.length).toBe(1);
    expect(record.messages[0]!.getType()).toBe('system');
    expect(record.updatedAt).toBeGreaterThan(1);
  });

  test('explicit keepTurns=10 keeps 10', async () => {
    const { record } = await compressSession(recordWith(12), streamModel(['提要']), 10);
    expect(splitTurns(record.messages).turns.length).toBe(10);
  });

  test('keepTurns below 1 clamps to 1', async () => {
    const { record } = await compressSession(recordWith(3), streamModel(['提要']), 0);
    expect(splitTurns(record.messages).turns.length).toBe(1);
  });

  test('at or below keepTurns is a no-op returning the original record', async () => {
    const rec = recordWith(10);
    const { compressed, record } = await compressSession(rec, streamModel(['x']), 10);
    expect(compressed).toBe(false);
    expect(record).toBe(rec);
  });

  test('empty summary is treated as failure', async () => {
    const { compressed, error } = await compressSession(recordWith(12), streamModel(['   ']), 10);
    expect(compressed).toBe(false);
    expect(error).toBeDefined();
  });

  test('rolling merge: previous summary appears in the prompt', async () => {
    const model = streamModel(['新提要']);
    await compressSession(recordWith(12, { summary: '旧提要内容' }), model, 10);
    expect(model.prompts[0]).toContain('旧提要内容');
  });

  test('huge old transcript is truncated before invoking the model', async () => {
    const model = streamModel(['提要']);
    await compressSession(recordWith(12, { longTurn: true }), model, 10);
    expect(model.prompts[0]!.length).toBeLessThan(TRANSCRIPT_LIMIT + 2_000);
    expect(model.prompts[0]).toContain('更早内容已截断');
  });
});

describe('estimateTokens', () => {
  test('sums content chars / 4, floors; empty → 0', () => {
    expect(estimateTokens([])).toBe(0);
    expect(estimateTokens([new HumanMessage('a'.repeat(40))])).toBe(10);
    expect(
      estimateTokens([new HumanMessage('x'.repeat(10)), new AIMessage('y'.repeat(30))]),
    ).toBe(10);
    expect(estimateTokens([new HumanMessage('abcd')])).toBe(1);
  });

  test('counts tool_calls args payloads (often the largest text)', () => {
    const ai = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 'write_file', args: { content: 'x'.repeat(200) } }],
    });
    expect(estimateTokens([ai])).toBeGreaterThanOrEqual(50);
  });
});

describe('shouldAutoCompact', () => {
  test('token 口径:达到预算触发,差一点不触发(旧 chars 用例迁移)', () => {
    expect(shouldAutoCompact([new HumanMessage('a'.repeat(200))], { contextTokens: 50 })).toBe(true);
    expect(shouldAutoCompact([new HumanMessage('a'.repeat(196))], { contextTokens: 50 })).toBe(false);
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

describe('cjk-aware estimateTokens', () => {
  test('中文字符 1.5 字/token,ASCII 4 字/token,混合线性可加', async () => {
    const { estimateTokens } = await import('./compact.js');
    const { HumanMessage } = await import('@langchain/core/messages');
    const cjk = new HumanMessage('中'.repeat(1500));   // ≈ 1000 tokens
    const ascii = new HumanMessage('a'.repeat(4000));  // = 1000 tokens
    const mixed = new HumanMessage('中'.repeat(750) + 'a'.repeat(2000)); // 500 + 500
    expect(estimateTokens([cjk])).toBe(1000);
    expect(estimateTokens([ascii])).toBe(1000);
    expect(estimateTokens([mixed])).toBe(1000);
  });

  test('shouldAutoCompact 用 token 预算直接比较(>=)', async () => {
    const { shouldAutoCompact } = await import('./compact.js');
    const { HumanMessage } = await import('@langchain/core/messages');
    const msgs = [new HumanMessage('a'.repeat(4000))]; // 1000 tokens
    expect(shouldAutoCompact(msgs, { contextTokens: 1000 })).toBe(true);
    expect(shouldAutoCompact(msgs, { contextTokens: 1001 })).toBe(false);
  });
});

describe('resolveContextTokens', () => {
  test('优先级链:byModel > env(TOKENS) > env(CHARS/4) > contextTokens > thresholdChars/4 > 100k', async () => {
    const { resolveContextTokens } = await import('./compact.js');
    const base = { enabled: true, contextTokens: 50_000 };
    // byModel 压 env
    expect(resolveContextTokens('glmc:glm-5.3', { TRANSCODE_COMPACT_TOKENS: '9' }, { autoCompact: { ...base, byModel: { 'glmc:glm-5.3': 1_000_000 } } } as never))
      .toMatchObject({ tokens: 1_000_000, source: 'byModel' });
    // env 压 global
    expect(resolveContextTokens('x', { TRANSCODE_COMPACT_TOKENS: '9' }, { autoCompact: base } as never))
      .toMatchObject({ tokens: 9, source: 'env' });
    // 新 env 优先于旧 env
    expect(resolveContextTokens('x', { TRANSCODE_COMPACT_TOKENS: '9', TRANSCODE_COMPACT_CHARS: '400' }, { autoCompact: { enabled: true } } as never))
      .toMatchObject({ tokens: 9, source: 'env' });
    expect(resolveContextTokens('x', { TRANSCODE_COMPACT_CHARS: '400' }, { autoCompact: { enabled: true } } as never))
      .toMatchObject({ tokens: 100, source: 'env' });
    // global 与旧字段别名
    expect(resolveContextTokens('x', {}, { autoCompact: base } as never))
      .toMatchObject({ tokens: 50_000, source: 'global' });
    expect(resolveContextTokens('x', {}, { autoCompact: { enabled: true, thresholdChars: 200_000 } } as never))
      .toMatchObject({ tokens: 50_000, source: 'global' });
    // 默认
    expect(resolveContextTokens('x', {}, { autoCompact: { enabled: true } } as never))
      .toMatchObject({ tokens: 100_000, source: 'default' });
  });

  test('enabled 总闸与 0 暗门', async () => {
    const { resolveContextTokens } = await import('./compact.js');
    expect(resolveContextTokens('x', {}, { autoCompact: { enabled: false, byModel: { x: 5 } } } as never))
      .toMatchObject({ enabled: false });
    expect(resolveContextTokens('x', {}, { autoCompact: { enabled: true, byModel: { x: 0 } } } as never))
      .toMatchObject({ tokens: 0, source: 'byModel' });
  });
});

describe('resolveContextTokens boolean master switch', () => {
  test('autoCompact: false 布尔形态 → enabled:false(不被静默重开)', async () => {
    const { resolveContextTokens } = await import('./compact.js');
    expect(resolveContextTokens('x', {}, { autoCompact: false } as never))
      .toMatchObject({ enabled: false });
    expect(resolveContextTokens('x', {}, { autoCompact: true } as never))
      .toMatchObject({ enabled: true });
  });
});
