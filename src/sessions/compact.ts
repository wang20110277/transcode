import { AIMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages';
import type { SessionRecord } from './store.js';

/** Verbatim window kept on compaction; older turns get distilled. */
export const KEEP_TURNS = 10;

/** Cap on the transcript fed to the distilling model (protects its context). */
export const TRANSCRIPT_LIMIT = 40_000;

/** Minimal model surface needed for distillation (mock-friendly). */
export interface CompactModel {
  invoke(input: string): Promise<{ content: unknown }>;
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

function replyText(content: unknown): string {
  return (typeof content === 'string' ? content : JSON.stringify(content)).trim();
}

/**
 * Distill turns older than the kept window into `summary`, returning a new
 * record trimmed to [leading, last KEEP_TURNS turns]. ≤KEEP_TURNS or a failed
 * model call returns the original record unchanged (with `error` set on
 * failure) — callers fall back to a full restore.
 */
export async function compressSession(
  record: SessionRecord,
  model: CompactModel,
): Promise<{ compressed: boolean; record: SessionRecord; error?: string }> {
  const { leading, turns } = splitTurns(record.messages);
  if (turns.length <= KEEP_TURNS) return { compressed: false, record };
  const keep = turns.slice(-KEEP_TURNS);
  const old = turns.slice(0, turns.length - KEEP_TURNS);
  let summary: string;
  try {
    const response = await model.invoke(buildPrompt(record.summary, old));
    summary = replyText(response.content);
  } catch (error) {
    return { compressed: false, record, error: error instanceof Error ? error.message : String(error) };
  }
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
