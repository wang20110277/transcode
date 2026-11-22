import { z } from 'zod';
import type { AgentTool } from './types.js';
import { loadConfig } from '../../config.js';
import { normalizeWebSearchConfig, runWebSearch } from '../../provider/web-search.js';

export const webSearchTool: AgentTool = {
  name: 'web_search',
  description:
    'Search the web via the user-configured provider (tavily|brave). Returns ' +
    'title/url/snippet hits — pair with web_fetch to read a promising result.',
  kind: 'fetch',
  isMutating: false,
  isEnabled: () => normalizeWebSearchConfig(loadConfig().webSearch) !== null,
  schema: z.object({
    query: z.string().min(1).describe('Search query'),
    maxResults: z.number().int().min(1).max(20).optional().describe('Hits to return (default 5)'),
  }),
  title: (input) => `web_search ${input.query}`,
  async execute(input) {
    const cfg = normalizeWebSearchConfig(loadConfig().webSearch);
    if (!cfg) {
      return (
        'Error: web_search not configured — set webSearch { provider, apiKey } in ' +
        '~/.transcode.json or run /search.'
      );
    }
    try {
      const hits = await runWebSearch(
        cfg,
        String(input.query),
        input.maxResults ? Number(input.maxResults) : undefined,
      );
      if (hits.length === 0) return `No results for: ${input.query}`;
      return hits.map((hit) => `${hit.title} — ${hit.url}\n${hit.snippet}`).join('\n\n');
    } catch (error) {
      return `Error: web_search failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
