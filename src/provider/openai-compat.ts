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

export async function toolCallArgsSafeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const body = typeof init?.body === 'string' ? serializeToolCallArgsInBody(init.body) : init?.body;
  const res = await globalThis.fetch(input, body === init?.body ? init : { ...init, body });
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
