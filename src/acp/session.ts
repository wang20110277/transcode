import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { createModel, getAvailableModels, resolveModel } from '../provider/provider.js';
import { runAgentLoop, type AgentEvent, type PermissionRequest } from '../agent/loop.js';
import { createToolSession, type ToolSession } from '../agent/tools/index.js';
import { getPermissionMode } from '../agent/permission.js';
import { buildSystemPrompt, loadProjectContext } from '../agent/system-prompt.js';
import {
  RPC_ERRORS,
  RpcError,
} from './transport.js';
import type {
  AcpModelInfo,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptBlock,
  AcpPromptParams,
  AcpPromptResult,
  AcpSessionModelState,
  AcpSessionNewResult,
  AcpSessionUpdate,
  AcpStopReason,
} from './protocol.js';

export interface AcpSessionHost {
  sendUpdate(sessionId: string, update: AcpSessionUpdate): void;
  requestPermission(
    request: AcpPermissionRequest,
    signal?: AbortSignal,
  ): Promise<AcpPermissionResponse>;
}

const MAX_TOOL_OUTPUT_IN_UPDATE = 20_000;

function modelCatalog(currentId: string): AcpModelInfo[] {
  const models: AcpModelInfo[] = getAvailableModels().map((model) => ({
    modelId: model.id,
    name: model.name,
  }));
  if (!models.some((model) => model.modelId === currentId)) {
    models.unshift({ modelId: currentId, name: currentId });
  }
  return models;
}

function promptText(prompt: AcpPromptBlock[]): string {
  return prompt
    .map((block) => {
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'resource_link') {
        return `[resource: ${String(block.uri ?? block.name ?? 'unknown')}]`;
      }
      if (block.type === 'resource') {
        return `[embedded resource${block.uri ? `: ${String(block.uri)}` : ''}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function permissionMode(): 'ask' | 'auto' | 'readonly' {
  return getPermissionMode();
}

export class AcpSession {
  readonly id = `ses_${randomUUID()}`;
  readonly messages: BaseMessage[] = [];
  private busy = false;
  private abortController?: AbortController;
  private modelSpec: string;
  /** Shared across prompts: shell cwd persistence and read-file tracking. */
  private readonly toolSession: ToolSession;

  constructor(
    private readonly host: AcpSessionHost,
    readonly cwd: string,
    modelSpec?: string,
  ) {
    this.modelSpec = modelSpec?.trim() || process.env.TRANSCODE_MODEL || '';
    this.toolSession = createToolSession(cwd);
  }

  get modelState(): AcpSessionModelState {
    const resolved = resolveModel(this.modelSpec);
    return {
      availableModels: modelCatalog(resolved.id),
      currentModelId: resolved.id,
    };
  }

  setModel(modelId: string): AcpSessionModelState {
    const trimmed = modelId.trim();
    if (!trimmed) throw new RpcError(RPC_ERRORS.invalidParams, 'modelId is required');
    this.modelSpec = trimmed;
    return this.modelState;
  }

  cancel(): void {
    this.abortController?.abort();
  }

  async prompt(params: AcpPromptParams): Promise<AcpPromptResult> {
    if (this.busy) {
      throw new RpcError(-32000, 'Session is already processing a prompt');
    }

    const text = promptText(params.prompt ?? []);
    if (!text) return { stopReason: 'end_turn' };

    this.busy = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      const provider =
        process.env.TRANSCODE_MOCK === '1' ? undefined : createModel(this.modelSpec);
      const systemPrompt = buildSystemPrompt(await loadProjectContext(this.cwd), {
        modelName: provider?.config.name,
      });
      if (this.messages[0]?.getType() === 'system') {
        this.messages[0] = new SystemMessage(systemPrompt);
      } else {
        this.messages.unshift(new SystemMessage(systemPrompt));
      }

      this.messages.push(new HumanMessage(text));

      const result = await runAgentLoop({
        model: provider?.model,
        cwd: this.cwd,
        messages: this.messages,
        systemPrompt,
        signal,
        toolSession: this.toolSession,
        onEvent: (event) => this.forwardEvent(event),
        requestPermission: (request) => this.askPermission(request, signal),
      });

      this.trimHistory();
      // 'stalled' has no ACP counterpart; report it as the closest reason.
      const stopReason =
        result.stopReason === 'stalled' ? 'max_turn_requests' : result.stopReason;
      return { stopReason: stopReason as AcpStopReason };
    } catch (error) {
      if (signal.aborted) return { stopReason: 'cancelled' };

      const message = error instanceof Error ? error.message : String(error);
      const errorText = `[transcode error] ${message}`;
      this.messages.push(new AIMessage({ content: errorText }));
      this.host.sendUpdate(this.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `\n${errorText}\n` },
      });
      return { stopReason: 'refusal' };
    } finally {
      this.busy = false;
      this.abortController = undefined;
    }
  }

  private trimHistory(): void {
    const MAX_MESSAGES = 80;
    const KEEP_RECENT = 60;
    if (this.messages.length <= MAX_MESSAGES) return;

    const system =
      this.messages[0]?.getType() === 'system' ? this.messages[0] : undefined;
    const recent = this.messages.slice(-KEEP_RECENT);
    while (recent.length > 0 && recent[0].getType() === 'tool') recent.shift();

    this.messages.length = 0;
    if (system) this.messages.push(system);
    this.messages.push(...recent);
  }

  private forwardEvent(event: AgentEvent): void {
    if (event.type === 'text') {
      this.host.sendUpdate(this.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: event.text },
      });
      return;
    }

    if (event.type === 'thought') {
      this.host.sendUpdate(this.id, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: event.text },
      });
      return;
    }

    if (event.type === 'max_turns_reached') {
      this.host.sendUpdate(this.id, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `\n⚠ Reached maximum number of turns (${event.maxTurns}). The task is incomplete — say "continue" or raise TRANSCODE_MAX_TURNS.\n`,
        },
      });
      return;
    }

    if (event.type === 'tool_call') {
      this.host.sendUpdate(this.id, {
        sessionUpdate: 'tool_call',
        toolCallId: event.toolCallId,
        name: event.name,
        title: event.title,
        kind: event.kind,
        status: 'pending',
        rawInput: event.input,
      });
      return;
    }

    const output =
      event.output.length > MAX_TOOL_OUTPUT_IN_UPDATE
        ? `${event.output.slice(0, MAX_TOOL_OUTPUT_IN_UPDATE)}\n... (truncated)`
        : event.output;

    this.host.sendUpdate(this.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: event.toolCallId,
      status: event.ok ? 'completed' : 'failed',
      name: event.name,
      content: [{ type: 'content', content: { type: 'text', text: output } }],
    });
  }

  private async askPermission(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    const mode = permissionMode();

    if (mode === 'auto') return true;
    if (mode === 'readonly') return false;

    try {
      const response = await this.host.requestPermission(
        {
          sessionId: this.id,
          toolCall: {
            toolCallId: request.toolCallId,
            title: request.title,
            kind: request.kind,
            status: 'pending',
            rawInput: request.input,
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        },
        signal,
      );

      if (response.outcome.outcome !== 'selected') return false;
      return ['allow_once', 'allow_session', 'approve_for_session'].includes(
        response.outcome.optionId,
      );
    } catch (error) {
      process.stderr.write(
        `[transcode] permission request failed, denying ${request.name}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return false;
    }
  }
}

export function sessionCwd(input: unknown): string {
  if (typeof input === 'string' && input.trim()) return path.resolve(input);
  return process.cwd();
}

export function sessionNewResult(session: AcpSession): AcpSessionNewResult {
  return { sessionId: session.id, models: session.modelState };
}
