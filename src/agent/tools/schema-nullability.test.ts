import { describe, expect, test } from 'bun:test';
import { memorySaveTool } from './memory.js';
import { webFetchTool } from './web-fetch.js';
import { webSearchTool } from './web-search.js';

/**
 * OpenAI structured outputs require every field (the SDK warns on bare
 * `.optional()`); the repo convention is `.nullable().optional()` so the
 * model may send explicit null AND providers that omit the key still pass.
 */
describe('tool schema nullability convention', () => {
  test('memory_save.description / web_fetch.prompt / web_search.maxResults 接受 null 与缺省', () => {
    expect(memorySaveTool.schema.safeParse({ name: 'n', type: 'user', content: 'c' }).success).toBe(true);
    expect(memorySaveTool.schema.safeParse({ name: 'n', type: 'user', content: 'c', description: null }).success).toBe(true);
    expect(webFetchTool.schema.safeParse({ url: 'https://x.dev/a' }).success).toBe(true);
    expect(webFetchTool.schema.safeParse({ url: 'https://x.dev/a', prompt: null }).success).toBe(true);
    expect(webSearchTool.schema.safeParse({ query: 'q' }).success).toBe(true);
    expect(webSearchTool.schema.safeParse({ query: 'q', maxResults: null }).success).toBe(true);
  });
});
