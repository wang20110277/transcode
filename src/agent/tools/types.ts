import type { z } from 'zod';
import type { ToolSession } from './session.js';

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
}

/** Rich execute result: model-facing output plus an optional UI-facing diff. */
export interface ToolOutput {
  output: string;
  /** Unified diff text for TUI rendering; never sent to the model. */
  diff?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  kind: ToolKind;
  isMutating: boolean;
  /** When true for a given input, a mutating tool may skip the permission prompt. */
  isReadOnly?(input: Record<string, unknown>): boolean;
  title(input: Record<string, unknown>): string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolOutput>;
}

export interface InvokeResult {
  ok: boolean;
  output: string;
  /** Unified diff text for UI rendering, when the tool produced one. */
  diff?: string;
}
