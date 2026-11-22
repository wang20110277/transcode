import { loadConfig, saveConfig } from '../config.js';

/**
 * Provider-agnostic web search: the user picks a search vendor and key in
 * ~/.transcode.json (webSearch section); transcode only provides the
 * adapters. Config is re-read on every use, so edits apply next turn.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchConfig {
  provider: 'tavily' | 'brave';
  apiKey: string;
}

const PROVIDERS: readonly WebSearchConfig['provider'][] = ['tavily', 'brave'];

/** null = not usable (absent OR malformed — distinguish with webSearchConfigWarning). */
export function normalizeWebSearchConfig(raw: unknown): WebSearchConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const provider = typeof obj.provider === 'string' ? obj.provider.trim().toLowerCase() : '';
  const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey.trim() : '';
  if (!(PROVIDERS as readonly string[]).includes(provider) || !apiKey) return null;
  return { provider: provider as WebSearchConfig['provider'], apiKey };
}

/** Present-but-broken config gets one warning line; a simply-absent section stays silent. */
export function webSearchConfigWarning(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (normalizeWebSearchConfig(raw)) return null;
  const provider = typeof (raw as Record<string, unknown>)?.provider === 'string'
    ? (raw as Record<string, unknown>).provider
    : '(missing)';
  return (
    `⚠ webSearch 配置无效(provider:${String(provider)};需 provider=tavily|brave 且 apiKey 非空),` +
    'web_search 已隐藏。运行 /search 重新配置,或手改 ~/.transcode.json'
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

async function tavilySearch(
  apiKey: string,
  query: string,
  maxResults: number,
  fetchImpl: typeof fetch,
): Promise<SearchHit[]> {
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
  });
  if (!res.ok) throw new Error(`tavily HTTP ${res.status}: ${await safeText(res)}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? []).map((hit) => ({
    title: hit.title ?? '',
    url: hit.url ?? '',
    snippet: hit.content ?? '',
  }));
}

async function braveSearch(
  apiKey: string,
  query: string,
  maxResults: number,
  fetchImpl: typeof fetch,
): Promise<SearchHit[]> {
  const qs = new URLSearchParams({ q: query, count: String(maxResults) }).toString();
  const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${qs}`, {
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
  });
  if (!res.ok) throw new Error(`brave HTTP ${res.status}: ${await safeText(res)}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).map((hit) => ({
    title: hit.title ?? '',
    url: hit.url ?? '',
    snippet: hit.description ?? '',
  }));
}

export async function runWebSearch(
  cfg: WebSearchConfig,
  query: string,
  maxResults = 5,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SearchHit[]> {
  if (cfg.provider === 'tavily') return tavilySearch(cfg.apiKey, query, maxResults, fetchImpl);
  if (cfg.provider === 'brave') return braveSearch(cfg.apiKey, query, maxResults, fetchImpl);
  throw new Error(`unknown search provider: ${String(cfg.provider)}`);
}

/** Persist provider+key into the config's webSearch section, preserving other keys. */
export function saveWebSearchConfig(provider: WebSearchConfig['provider'], apiKey: string): void {
  const config = loadConfig();
  saveConfig({ ...config, webSearch: { provider, apiKey } });
}
