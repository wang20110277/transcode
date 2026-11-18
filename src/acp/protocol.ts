/**
 * Minimal Agent Client Protocol (ACP) v1 types used by transcode.
 * Only the surface needed for a local coding agent is modelled here.
 */

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AcpPromptBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AcpSessionNewParams {
  cwd?: string;
  mcpServers?: unknown[];
  model?: string;
}

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpPromptBlock[];
}

export interface AcpSetModelParams {
  sessionId: string;
  modelId: string;
}

export interface AcpCancelParams {
  sessionId: string;
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface AcpSessionModelState {
  availableModels: AcpModelInfo[];
  currentModelId: string;
}

export interface AcpSessionNewResult {
  sessionId: string;
  models?: AcpSessionModelState;
  configOptions?: unknown[];
}

export interface AcpPromptResult {
  stopReason: AcpStopReason;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    kind: string;
    status: 'pending';
    rawInput: Record<string, unknown>;
  };
  options: AcpPermissionOption[];
}

export interface AcpPermissionResponse {
  outcome:
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' };
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}
