import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ToolCall, ToolCallChunk } from '@langchain/core/messages/tool';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import {
  AGENT_TOOLS,
  bindableTools,
  findAgentTool,
  invokeTool,
  createToolSession,
  type AgentTool,
  type ToolKind,
  type ToolSession,
} from './tools/index.js';
import { askRole, getRouting } from '../provider/provider.js';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'max_turns_reached'; maxTurns: number }
  | {
      type: 'tool_call';
      toolCallId: string;
      name: string;
      title: string;
      kind: ToolKind;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      toolCallId: string;
      name: string;
      output: string;
      ok: boolean;
      /** Unified diff for UI rendering; not sent to the model. */
      diff?: string;
      /** True when a mutating tool ran without prompting (read-only input). */
      skippedPermission?: boolean;
    };

export interface PermissionRequest {
  toolCallId: string;
  name: string;
  title: string;
  kind: ToolKind;
  input: Record<string, unknown>;
}

export type RequestPermission = (request: PermissionRequest) => Promise<boolean>;

export type StopReason =
  | 'end_turn'
  | 'cancelled'
  | 'max_turn_requests'
  | 'stalled'
  | 'refusal';

export interface AgentLoopOptions {
  model?: BaseChatModel;
  cwd: string;
  messages: BaseMessage[];
  systemPrompt: string;
  tools?: AgentTool[];
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void | Promise<void>;
  requestPermission?: RequestPermission;
  /** Session state shared across tool calls (shell cwd, read files). Created when absent. */
  toolSession?: ToolSession;
  /** Vision proxy override (tests). Default: routing.vision → askRole('vision'). */
  describeImages?: (images: Array<{ data: string; mediaType: string }>) => Promise<string>;
}

export interface AgentLoopResult {
  stopReason: StopReason;
  messages: BaseMessage[];
}

interface PartialToolCall {
  id?: string;
  name?: string;
  args: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object') {
        const value = block as Record<string, unknown>;
        if (typeof value.text === 'string') return value.text;
      }
      return '';
    })
    .join('');
}

function mergeToolCallChunk(map: Map<number, PartialToolCall>, chunk: ToolCallChunk): void {
  const index = typeof chunk.index === 'number' ? chunk.index : 0;
  const current = map.get(index) ?? { args: '' };
  if (chunk.id) current.id = chunk.id;
  if (chunk.name) current.name = chunk.name;
  if (typeof chunk.args === 'string') current.args += chunk.args;
  map.set(index, current);
}

function parseToolCalls(
  partials: Map<number, PartialToolCall>,
  finalChunk: AIMessageChunk | undefined,
  turn: number,
): ToolCall[] {
  const calls: ToolCall[] = [];

  if (partials.size === 0 && finalChunk?.tool_calls?.length) {
    return finalChunk.tool_calls;
  }

  for (const [index, partial] of [...partials.entries()].sort((a, b) => a[0] - b[0])) {
    if (!partial.name) continue;
    let args: Record<string, unknown> = {};
    if (partial.args.trim()) {
      try {
        const parsed = JSON.parse(partial.args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          args = { value: parsed };
        }
      } catch {
        args = { _raw: partial.args };
      }
    }
    calls.push({
      id: partial.id ?? `call_${turn}_${index}`,
      name: partial.name,
      args,
    });
  }

  return calls;
}

const REPEAT_GUIDANCE =
  'This exact command was already executed twice in a row with the same arguments; repeating it ' +
  'will not produce new information. Change your approach: use read_file to view file contents, ' +
  'narrow the search pattern, or answer from the results you already have.';

function stableKey(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
  }
  return JSON.stringify(value) ?? '';
}

function lastHumanText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].getType() === 'human') {
      return textFromContent(messages[index].content);
    }
  }
  return '';
}

async function runMockTurn(
  options: AgentLoopOptions,
  prompt: string,
): Promise<StopReason> {
  const toolSession = options.toolSession ?? createToolSession(options.cwd);
  if (prompt.includes('MOCK_TOOL_BASH')) {
    const tool = findAgentTool('bash');
    const input = { command: 'echo mock-tool-ok' };
    const toolCallId = 'mock_call_1';

    if (!tool) {
      await options.onEvent({ type: 'text', text: '[mock] bash tool is unavailable' });
      return 'end_turn';
    }

    await options.onEvent({
      type: 'tool_call',
      toolCallId,
      name: tool.name,
      title: tool.title(input),
      kind: tool.kind,
      input,
    });

    const allowed = options.requestPermission
      ? await options.requestPermission({
          toolCallId,
          name: tool.name,
          title: tool.title(input),
          kind: tool.kind,
          input,
        })
      : true;

    const result = allowed
      ? await invokeTool(tool, input, {
          cwd: toolSession.cwd,
          signal: options.signal,
          session: toolSession,
          requestPermission: options.requestPermission,
        })
      : { ok: false, output: 'Permission denied.' };

    await options.onEvent({
      type: 'tool_result',
      toolCallId,
      name: tool.name,
      output: result.output,
      ok: result.ok,
      diff: result.diff,
    });

    options.messages.push(
      new AIMessage({
        content: '',
        tool_calls: [{ id: toolCallId, name: 'bash', args: input }],
      }),
      new ToolMessage({
        content: result.output,
        tool_call_id: toolCallId,
        name: 'bash',
      }),
    );

    await options.onEvent({
      type: 'text',
      text: `[mock] tool completed: ${result.output.split('\n')[0] ?? ''}`,
    });
    return 'end_turn';
  }

  await options.onEvent({ type: 'text', text: `[mock] ${prompt}` });
  return 'end_turn';
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const messages = options.messages;
  if (!messages.some((message) => message.getType() === 'system')) {
    messages.unshift(new SystemMessage(options.systemPrompt));
  }

  if (process.env.TRANSCODE_MOCK === '1') {
    return {
      stopReason: await runMockTurn(options, lastHumanText(messages)),
      messages,
    };
  }

  const tools = options.tools ?? AGENT_TOOLS;
  // Claude Code style: generous default cap (their subagents use 200),
  // overridable via TRANSCODE_MAX_TURNS. Hitting it is loud, never silent.
  const envTurns = Number(process.env.TRANSCODE_MAX_TURNS);
  const maxTurns = options.maxTurns ?? (Number.isFinite(envTurns) && envTurns > 0 ? envTurns : 200);
  const toolSession = options.toolSession ?? createToolSession(options.cwd);
  if (!options.model) throw new Error('No model configured for the agent loop');

  const runnable =
    tools.length > 0 && options.model.bindTools
      ? options.model.bindTools(bindableTools(tools))
      : options.model;

  // Windowed repetition tracking: the same call (name + args) occurring
  // >= 3 times within the last 6 calls is refused, which catches both
  // straight repeats (A,A,A) and alternating loops (A,B,A,B,A).
  const recentKeys: string[] = [];

  // Exploration stall detection: too many calls with zero mutations means
  // the model is drilling instead of delivering (observed with DeepSeek:
  // 272 read-only calls to "update a README"). Nudge it once mid-run.
  const EXPLORE_STALL_THRESHOLD = 30;
  // Hard rail: when the stall nudge is ignored, stop burning turns.
  const STALL_GRACE_CALLS = 15;
  // Wrap-up detection: the deliverable was already written, but the model
  // keeps exploring instead of summarizing and ending its turn.
  const WRAP_UP_GAP = 20;
  let totalToolCalls = 0;
  let callsSinceAction = 0;
  let hasActed = false;
  let hasDelivered = false; // a real file write happened (write_file/edit_file)
  let stallNudged = false;
  let callsAtStallNudge = 0;
  let wrapUpNudged = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (options.signal?.aborted) return { stopReason: 'cancelled', messages };

    const partials = new Map<number, PartialToolCall>();
    let text = '';
    let finalChunk: AIMessageChunk | undefined;

    const stream = await runnable.stream(messages, {
      signal: options.signal,
    });

    for await (const chunk of stream) {
      if (options.signal?.aborted) return { stopReason: 'cancelled', messages };
      finalChunk = chunk;

      const delta = textFromContent(chunk.content);
      if (delta) {
        text += delta;
        await options.onEvent({ type: 'text', text: delta });
      }

      for (const toolCallChunk of chunk.tool_call_chunks ?? []) {
        mergeToolCallChunk(partials, toolCallChunk);
      }
    }

    if (options.signal?.aborted) return { stopReason: 'cancelled', messages };

    const toolCalls = parseToolCalls(partials, finalChunk, turn);
    messages.push(new AIMessage({ content: text, tool_calls: toolCalls }));

    if (toolCalls.length === 0) {
      return { stopReason: 'end_turn', messages };
    }

    for (const call of toolCalls) {
      if (options.signal?.aborted) return { stopReason: 'cancelled', messages };

      const input = (call.args ?? {}) as Record<string, unknown>;
      const tool = tools.find((item) => item.name === call.name) ?? findAgentTool(call.name);
      const toolCallId = call.id ?? `call_${turn}_${call.name}`;
      const title = tool ? tool.title(input) : call.name;

      await options.onEvent({
        type: 'tool_call',
        toolCallId,
        name: call.name,
        title,
        kind: tool?.kind ?? 'other',
        input,
      });

      let result: { ok: boolean; output: string; diff?: string; images?: Array<{ data: string; mediaType: string }> };
      let skippedPermission = false;

      // Circuit breaker (windowed): see recentKeys declaration.
      const key = `${call.name}:${stableKey(input)}`;
      const occurrences = recentKeys.filter((recent) => recent === key).length + 1;
      recentKeys.push(key);
      if (recentKeys.length > 6) recentKeys.shift();

      if (!tool) {
        result = { ok: false, output: `Unknown tool: ${call.name}` };
      } else if (occurrences >= 3) {
        result = { ok: false, output: `Error: ${REPEAT_GUIDANCE}` };
      } else {
        const readOnly = tool.isReadOnly?.(input) === true;
        const needsPermission = tool.isMutating && !readOnly;
        skippedPermission = tool.isMutating && readOnly;
        const allowed =
          !needsPermission || !options.requestPermission
            ? true
            : await options.requestPermission({
                toolCallId,
                name: tool.name,
                title,
                kind: tool.kind,
                input,
              });

        result = allowed
          ? await invokeTool(tool, input, {
              cwd: toolSession.cwd,
              signal: options.signal,
              session: toolSession,
              requestPermission: options.requestPermission,
            })
          : { ok: false, output: 'Permission denied by the client.' };

        if (allowed && tool.isMutating && tool.isReadOnly?.(input) !== true) {
          hasActed = true;
          callsSinceAction = 0;
          // "Delivered" means a file write; mutating bash is not a deliverable
          // and must not trigger the wrap-up message.
          if (tool.name === 'write_file' || tool.name === 'edit_file') {
            hasDelivered = true;
          }
        }
      }
      totalToolCalls++;
      callsSinceAction++;

      await options.onEvent({
        type: 'tool_result',
        toolCallId,
        name: call.name,
        output: result.output,
        ok: result.ok,
        diff: result.diff,
        skippedPermission,
      });

      // Image auto-proxy: when a vision role is routed (or a test describer
      // is injected), images are converted to a text description so the
      // primary model does not need multimodal support.
      let toolContent:
        | string
        | Array<{ type: string; text?: string; image_url?: { url: string } }> = result.output;
      if (result.images?.length) {
        const describer =
          options.describeImages ??
          (getRouting().vision
            ? (images: Array<{ data: string; mediaType: string }>) =>
                askRole(
                  'vision',
                  '简要描述图片的关键信息；如果是报错/截图，逐字给出其中文本。',
                  images,
                )
            : undefined);
        if (describer) {
          try {
            const description = await describer(result.images);
            toolContent = `${result.output}\n\n[vision] ${description}`;
          } catch {
            toolContent = [
              { type: 'text', text: `${result.output}\n[vision 转述失败，原图已直接传入]` },
              ...result.images.map((image) => ({
                type: 'image_url',
                image_url: { url: `data:${image.mediaType};base64,${image.data}` },
              })),
            ];
          }
        } else {
          toolContent = [
            { type: 'text', text: result.output },
            ...result.images.map((image) => ({
              type: 'image_url',
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })),
          ];
        }
      }

      messages.push(
        new ToolMessage({
          content: toolContent,
          tool_call_id: toolCallId,
          name: call.name,
        }),
      );
    }

    if (!hasActed && !stallNudged && totalToolCalls >= EXPLORE_STALL_THRESHOLD) {
      stallNudged = true;
      callsAtStallNudge = totalToolCalls;
      const nudge =
        `You have made ${totalToolCalls} tool calls without producing any edits or output. ` +
        'Stop exploring: synthesize what you already have and complete the task now ' +
        '(edit or write the deliverable, or answer directly). If you need file contents, ' +
        'read_file returns up to 2000 lines in one call — do not paginate with grep/sed windows.';
      messages.push(new AIMessage({ content: nudge }));
      await options.onEvent({ type: 'text', text: `\n⚠ ${nudge}\n` });
    } else if (
      !hasActed &&
      stallNudged &&
      totalToolCalls - callsAtStallNudge >= STALL_GRACE_CALLS
    ) {
      // Hard rail: the nudge was ignored. Fail fast and loudly instead of
      // burning the remaining turns.
      const notice =
        `The agent made ${totalToolCalls} tool calls without starting the deliverable and ` +
        'ignored the earlier reminder. Stopping to avoid wasting turns. Re-prompt with a more ' +
        'specific instruction (name the exact file and what to change) or switch to a stronger model.';
      messages.push(new AIMessage({ content: notice }));
      await options.onEvent({ type: 'text', text: `\n⚠ ${notice}\n` });
      return { stopReason: 'stalled', messages };
    } else if (
      hasDelivered &&
      !wrapUpNudged &&
      callsSinceAction >= WRAP_UP_GAP
    ) {
      wrapUpNudged = true;
      const nudge =
        `The deliverable has already been written, but you have made ${callsSinceAction} ` +
        'more tool calls since. Run any final verification now if truly needed, then ' +
        'reply with a summary of what changed and stop — further exploration is not needed.';
      messages.push(new AIMessage({ content: nudge }));
      await options.onEvent({ type: 'text', text: `\n⚠ ${nudge}\n` });
    }
  }

  // Record the cap in the conversation (like Claude Code's max_turns_reached
  // attachment) and surface it as an event so no surface stays silent.
  const notice = new AIMessage({
    content: `Reached maximum number of turns (${maxTurns}). The task is incomplete — ask the user to say "continue" or raise TRANSCODE_MAX_TURNS.`,
  });
  messages.push(notice);
  await options.onEvent({ type: 'max_turns_reached', maxTurns });
  return { stopReason: 'max_turn_requests', messages };
}
