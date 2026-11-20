import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from '@langchain/core/messages';

/** A persisted conversation (one JSON file under ~/.transcode/sessions). */
export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  model: string;
  messages: BaseMessage[];
}

interface StoredMessage {
  type: string;
  content: MessageContent;
  tool_calls?: AIMessage['tool_calls'];
  tool_call_id?: string;
  name?: string;
}

// Test isolation mirrors TRANSCODE_CONFIG_PATH.
const sessionsDir = (): string =>
  process.env.TRANSCODE_SESSIONS_DIR ?? path.join(homedir(), '.transcode', 'sessions');

function serialize(messages: BaseMessage[]): StoredMessage[] {
  return messages.map((message) => {
    const stored: StoredMessage = { type: message.getType(), content: message.content };
    const ai = message as AIMessage;
    if (ai.tool_calls?.length) stored.tool_calls = ai.tool_calls;
    const tool = message as ToolMessage;
    if (tool.tool_call_id) {
      stored.tool_call_id = tool.tool_call_id;
      stored.name = tool.name;
    }
    return stored;
  });
}

function deserialize(stored: StoredMessage[]): BaseMessage[] {
  return stored.map((item) => {
    const content = item.content as MessageContent;
    switch (item.type) {
      case 'system':
        return new SystemMessage({ content: content as string });
      case 'ai':
        return new AIMessage({
          content,
          ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
        });
      case 'tool':
        return new ToolMessage({
          content: content as string,
          tool_call_id: item.tool_call_id ?? '',
          name: item.name ?? 'tool',
        });
      default:
        return new HumanMessage({ content });
    }
  });
}

function readRecord(file: string): SessionRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Omit<SessionRecord, 'messages'> & {
      messages: StoredMessage[];
    };
    return { ...parsed, messages: deserialize(parsed.messages ?? []) };
  } catch {
    return null;
  }
}

export function saveSession(record: SessionRecord): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${record.id}.json`),
    JSON.stringify({ ...record, messages: serialize(record.messages) }, null, 2),
  );
}

/** All conversations, newest first. */
export function listSessions(): SessionRecord[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readRecord(path.join(dir, file)))
    .filter((record): record is SessionRecord => record !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id: string): SessionRecord | undefined {
  const record = readRecord(path.join(sessionsDir(), `${id}.json`));
  return record ?? undefined;
}

/** Keyword search over titles AND message content (case-insensitive). */
export function searchSessions(keyword: string): SessionRecord[] {
  const query = keyword.trim().toLowerCase();
  if (!query) return listSessions();
  return listSessions().filter(
    (record) =>
      record.title.toLowerCase().includes(query) ||
      record.messages.some((message) =>
        typeof message.content === 'string'
          ? message.content.toLowerCase().includes(query)
          : JSON.stringify(message.content).toLowerCase().includes(query),
      ),
  );
}

/**
 * Model-generated conversation title (≤12 chars). Returns the derived
 * fallback when the model call fails.
 */
export async function generateTitle(
  model: { invoke: (input: string) => Promise<{ content: unknown }> },
  firstUserText: string,
  firstAssistantText: string,
): Promise<string> {
  const fallback = firstUserText.replace(/\s+/g, ' ').trim().slice(0, 24) || '新对话';
  try {
    const response = await model.invoke(
      '为下面这段对话生成一个不超过 12 个字的中文标题，只输出标题本身，不要标点。\n' +
        `用户：${firstUserText.slice(0, 500)}\n助手：${firstAssistantText.slice(0, 500)}`,
    );
    const text = (typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)
    )
      .replace(/["“”'‘’\s]/g, '')
      .slice(0, 16);
    return text.length >= 2 ? text : fallback;
  } catch {
    return fallback;
  }
}
