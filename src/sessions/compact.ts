import { AIMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages';
import type { SessionRecord } from './store.js';

/** Default verbatim window kept on compaction; older turns get distilled. */
export const DEFAULT_KEEP_TURNS = 1;

/** Cap on the transcript fed to the distilling model (protects its context). */
export const TRANSCRIPT_LIMIT = 40_000;

/** Cap on the distilled summary: stop consuming the stream past this. */
export const COMPACT_MAX_SUMMARY_CHARS = 1200;

/** Minimal streaming model surface needed for distillation (mock-friendly). */
export interface CompactModel {
  stream(input: string): AsyncIterable<{ content: unknown }>;
}

/**
 * Split a message list into leading (pre-first-human) messages and turns.
 * A turn starts at each HumanMessage and owns every AI/Tool message until
 * the next HumanMessage.
 */
export function splitTurns(messages: BaseMessage[]): {
  leading: BaseMessage[];
  turns: BaseMessage[][];
} {
  const leading: BaseMessage[] = [];
  const turns: BaseMessage[][] = [];
  for (const message of messages) {
    if (turns.length === 0 && message.getType() !== 'human') {
      leading.push(message);
      continue;
    }
    if (message.getType() === 'human') turns.push([message]);
    else turns[turns.length - 1]!.push(message);
  }
  return { leading, turns };
}

const contentText = (content: MessageContent): string =>
  typeof content === 'string' ? content : JSON.stringify(content);

function messageLine(message: BaseMessage): string {
  const kind = message.getType();
  const text = contentText(message.content);
  if (kind === 'human') return `用户: ${text}`;
  if (kind === 'tool') return `工具结果: ${text}`;
  if (kind === 'ai') {
    const calls = (message as AIMessage).tool_calls?.map((c) => c.name).join(', ');
    return `助手: ${text}${calls ? ` [调用 ${calls}]` : ''}`;
  }
  return `系统: ${text}`;
}

function renderTranscriptText(turns: BaseMessage[][]): string {
  const body = turns
    .map((msgs, i) => `— 第${i + 1}轮 —\n${msgs.map(messageLine).join('\n')}`)
    .join('\n\n');
  if (body.length <= TRANSCRIPT_LIMIT) return body;
  return `(更早内容已截断)\n${body.slice(-TRANSCRIPT_LIMIT)}`;
}

function buildPrompt(previousSummary: string | undefined, oldTurns: BaseMessage[][]): string {
  const head =
    '把下面的对话历史提炼成一份"前情提要",供后续对话延续上下文使用。' +
    '必须保留:已做的决定与结论、关键事实(涉及的文件、代码、命令、错误)、尚未完成的事项。' +
    '直接输出提要正文,不要标题和客套,不超过 500 字。';
  const prior = previousSummary
    ? `\n已有前情提要(在此基础上合并更新):\n${previousSummary}\n`
    : '';
  return `${head}${prior}\n对话历史:\n${renderTranscriptText(oldTurns)}`;
}

/**
 * Validate a raw keep-turns argument: undefined → default (no opinion),
 * pure digits ≥1 → {keep}, anything else → {error} so callers can show a
 * usage hint and proceed with the default.
 */
export function parseKeepCount(raw: string | undefined): { keep?: number; error?: string } {
  if (raw === undefined) return {};
  if (/^\d+$/.test(raw) && Number(raw) >= 1) return { keep: Number(raw) };
  return { error: `保留轮数需为 ≥1 的整数,已按默认 ${DEFAULT_KEEP_TURNS} 轮执行` };
}

/**
 * Distill turns older than the kept window into `summary`, returning a new
 * record trimmed to [leading, last keepTurns turns]. At or below the window,
 * or on a failed model call, returns the original record unchanged (with
 * `error` set on failure) — callers fall back to a full restore.
 */
export async function compressSession(
  record: SessionRecord,
  model: CompactModel,
  keepTurns = DEFAULT_KEEP_TURNS,
  onDelta?: (delta: string) => void,
): Promise<{ compressed: boolean; record: SessionRecord; error?: string }> {
  const window = Math.max(1, keepTurns);
  const { leading, turns } = splitTurns(record.messages);
  if (turns.length <= window) return { compressed: false, record };
  const keep = turns.slice(-window);
  const old = turns.slice(0, turns.length - window);
  let raw = '';
  try {
    for await (const chunk of model.stream(buildPrompt(record.summary, old))) {
      const text = typeof chunk.content === 'string' ? chunk.content : '';
      if (text) onDelta?.(text);
      raw += text;
      if (raw.length >= COMPACT_MAX_SUMMARY_CHARS) break;
    }
  } catch (error) {
    return { compressed: false, record, error: error instanceof Error ? error.message : String(error) };
  }
  const summary = raw.slice(0, COMPACT_MAX_SUMMARY_CHARS).trim();
  if (!summary) return { compressed: false, record, error: '模型返回了空前情提要' };
  return {
    compressed: true,
    record: {
      ...record,
      summary,
      messages: [...leading, ...keep.flat()],
      updatedAt: Date.now(),
    },
  };
}

/**
 * History entries for the restored view: optional digest first, then one
 * entry per message — human turns as `input` (rule-framed highlight), AI
 * replies as full-length `output`. Tool activity and system messages are
 * not replayed. Rendering is the existing per-entry chat form.
 */
export function transcriptEntries(
  summary: string | null,
  messages: BaseMessage[],
  oldTurnsCount?: number,
): { input: string; output: string }[] {
  const entries: { input: string; output: string }[] = [];
  if (summary) {
    entries.push({
      input: '',
      output: `📝 前情提要${oldTurnsCount ? `(旧 ${oldTurnsCount} 轮)` : ''}\n${summary}`,
    });
  }
  for (const message of messages) {
    const kind = message.getType();
    if (kind === 'human') entries.push({ input: contentText(message.content), output: '' });
    else if (kind === 'ai') {
      const text = contentText(message.content);
      if (text) entries.push({ input: '', output: text });
    }
  }
  return entries;
}
