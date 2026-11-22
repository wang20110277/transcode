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

/** fetch wrapper for ChatOpenAI `configuration.fetch`. */
export function toolCallArgsSafeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (typeof init?.body === 'string') {
    return globalThis.fetch(input, { ...init, body: serializeToolCallArgsInBody(init.body) });
  }
  return globalThis.fetch(input, init);
}
