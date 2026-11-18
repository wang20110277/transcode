/**
 * Manual check against a real Anthropic-compatible gateway.
 * Requires ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (or TRANSCODE_MODEL + keys).
 */
import { createModel, resolveModel } from '../src/provider/provider.js';

const spec = process.argv[2];
const resolved = resolveModel(spec);
const provider = createModel(spec);

console.log('resolved:', {
  id: resolved.id,
  provider: resolved.provider,
  model: resolved.model,
  baseUrl: resolved.baseUrl ?? '(env)',
  envKey: resolved.envKey,
});

const stream = await provider.model.stream('Reply with exactly one word: pong');
let text = '';
for await (const chunk of stream) {
  const content = chunk.content;
  if (typeof content === 'string') text += content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && 'text' in block) {
        text += String((block as { text: unknown }).text ?? '');
      }
    }
  }
}

console.log('reply:', JSON.stringify(text));
if (!text.trim()) {
  console.error('No text returned');
  process.exit(1);
}
