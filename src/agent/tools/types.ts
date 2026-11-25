import type { z } from 'zod';
import type { ToolSession } from './session.js';
import type { PermissionMode } from '../permission.js';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Session-scoped state shared across tool calls (shell cwd, read files). */
  session: ToolSession;
  /** Forwarded permission asker, so nested agents respect the same gate. */
  requestPermission?: (request: {
    toolCallId: string;
    name: string;
    title: string;
    kind: ToolKind;
    input: Record<string, unknown>;
    /** The rule "always allow" would remember; absent when a configured `ask` rule caused the question. */
    alwaysRule?: string;
  }) => Promise<boolean>;
  /** Event sink for nested agent progress (dispatch_agent forwards here). */
  emit?: (event: { type: 'tool_call'; [key: string]: unknown }) => void;
  /** Permission mode of the run that owns this context, so nested agents are gated the same way. */
  permissionMode?: PermissionMode;
}

/** Rich execute result: model-facing output plus optional extras. */
export interface ToolOutput {
  output: string;
  /** Unified diff text for TUI rendering; never sent to the model. */
  diff?: string;
  /** Base64 images sent to the model as multimodal content blocks. */
  images?: Array<{ data: string; mediaType: string }>;
}

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  kind: ToolKind;
  isMutating: boolean;
  /** When true for a given input, a mutating tool may skip the permission prompt. */
  isReadOnly?(input: Record<string, unknown>): boolean;
  /** When false, the tool is left out of the per-turn tool table (e.g. unconfigured). */
  isEnabled?: () => boolean;
  title(input: Record<string, unknown>): string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolOutput>;
}

export interface InvokeResult {
  ok: boolean;
  output: string;
  /** Unified diff text for UI rendering, when the tool produced one. */
  diff?: string;
  /** Base64 images for multimodal-capable models. */
  images?: Array<{ data: string; mediaType: string }>;
}
