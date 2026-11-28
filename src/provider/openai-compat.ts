/**
 * OpenAI-compatible gateway fixes applied at the request boundary.
 *
 * Some gateways (notably Zhipu GLM's coding endpoint, error 1210) reject
 * assistant-history tool_calls whose `function.arguments` is a JSON OBJECT;
 * the spec shape is a STRING. @langchain/openai serializes our object args
 * as-is, so multi-round tool calling dies on the second round — the gateway
 * answers with an error the SDK surfaces as an empty stream. Rewriting
 * object arguments to their JSON string form on the way out is invisible to
 * spec-compliant gateways (string arguments pass through untouched).
 */

export function serializeToolCallArgsInBody(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object') return body;
  const record = parsed as { messages?: unknown[] };
  if (!Array.isArray(record.messages)) return body;

  let changed = false;
  for (const message of record.messages) {
    if (!message || typeof message !== 'object') continue;
    const assistant = message as {
      role?: string;
      tool_calls?: Array<{ function?: { arguments?: unknown } }>;
    };
    if (assistant.role !== 'assistant' || !Array.isArray(assistant.tool_calls)) continue;
    for (const call of assistant.tool_calls) {
      const args = call.function?.arguments;
      if (args !== null && args !== undefined && typeof args === 'object') {
        call.function!.arguments = JSON.stringify(args);
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(record) : body;
}


/**
 * Completion cap: default UNLIMITED. Thinking models count reasoning tokens
 * against max_tokens, so a fixed 8192 cap truncated long thinking rounds
 * before any content was emitted (empty replies). Each gateway applies its
 * own model-appropriate default when the field is omitted.
 */
export function resolveMaxTokens(env: Record<string, string | undefined>): number | undefined {
  const raw = Number(env.TRANSCODE_MAX_TOKENS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/**
 * TRANSCODE_DEBUG_WIRE=1: append per-request diagnostics (URL, message
 * count, response status, finish_reason, usage) to ~/.transcode/wire-debug.log
 * — the ground truth for "empty response" investigations.
 */
export function wireDebugEnabled(): boolean {
  return process.env.TRANSCODE_DEBUG_WIRE === '1';
}

/**
 * Same gateways, second hole: some streamed responses omit `role` on the
 * assistant deltas entirely (observed on GLM coding glm-5.3-flash when all
 * thinking stays server-side — usage counts reasoning_tokens but no
 * reasoning_content ever streams, and tool_calls deltas arrive bare).
 * @langchain/openai's converter only builds tool_call_chunks in its
 * `role === "assistant"` branch and learns `defaultRole` from `delta.role`,
 * so a stream that never carries a role drops every tool call into a
 * role-less ChatMessageChunk — surfacing as a phantom "empty response".
 *
 * Fix at the same request boundary: rewrite the SSE so the FIRST role-less
 * delta gets `"role": "assistant"` injected. LangChain's defaultRole learning
 * then covers the rest of the stream. Streams that already carry a role
 * (every spec-compliant gateway) pass through byte-identical.
 */
interface RoleInjectionState {
  roleEstablished: boolean;
}

function rewriteSSELine(line: string, state: RoleInjectionState): string {
  if (state.roleEstablished) return line;
  const crlf = line.endsWith('\r');
  const bare = crlf ? line.slice(0, -1) : line;
  if (!bare.startsWith('data:')) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bare.slice(5));
  } catch {
    return line; // [DONE] or malformed — pass through untouched
  }
  const delta = (parsed as { choices?: [{ delta?: { role?: unknown } }] })?.choices?.[0]?.delta;
  if (!delta || typeof delta !== 'object') return line;
  if (delta.role !== undefined) {
    state.roleEstablished = true;
    return line;
  }
  delta.role = 'assistant';
  state.roleEstablished = true;
  return 'data: ' + JSON.stringify(parsed) + (crlf ? '\r' : '');
}

export function ensureAssistantRoleInSSE(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: RoleInjectionState = { roleEstablished: false };
  let pending = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          controller.enqueue(encoder.encode(rewriteSSELine(line, state) + '\n'));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(rewriteSSELine(pending, state)));
      },
    }),
  );
}

export async function toolCallArgsSafeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const body = typeof init?.body === 'string' ? serializeToolCallArgsInBody(init.body) : init?.body;
  const res = await globalThis.fetch(input, body === init?.body ? init : { ...init, body });
  // SSE role 注入只对事件流生效;注入会改变字节长度,必须剔掉陈旧的
  // content-length,否则消费端可能按旧长度截断。其他响应类型原样返回。
  const contentType = res.headers.get('content-type') ?? '';
  if (res.body && contentType.includes('text/event-stream')) {
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    return new Response(ensureAssistantRoleInSSE(res.body), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
  if (wireDebugEnabled()) {
    try {
      const clone = res.clone();
      const text = await clone.text();
      let finish = '';
      let usage = '';
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        try {
          const j = JSON.parse(line.slice(6));
          if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
          if (j.usage) usage = JSON.stringify(j.usage);
          if (j.error) finish += ' ERROR:' + JSON.stringify(j.error).slice(0, 200);
        } catch {}
      }
      const { appendFileSync, mkdirSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const dir = homedir() + '/.transcode';
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        dir + '/wire-debug.log',
        `[${new Date().toISOString()}] ${String(input).slice(0, 80)} status=${res.status} finish=${finish || '(stream)'} ${usage}\n`,
      );
    } catch {
      // Debug logging must never break the request.
    }
  }
  return res;
}
