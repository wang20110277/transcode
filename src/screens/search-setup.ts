import type { WebSearchCheck, WebSearchConfig } from '../provider/web-search.js';

/**
 * /search key-step orchestration, extracted so the flow is testable without
 * the REPL: reuse a saved key on empty input, run a live check, persist only
 * on success, and abandon the outcome entirely when the run went stale
 * (the user pressed Esc while the check was in flight).
 */

export interface SearchSetupDeps {
  /** Current persisted config (for the "Enter keeps the saved key" path). */
  savedConfig: () => WebSearchConfig | null;
  /** Live connectivity check (never throws). */
  check: (cfg: WebSearchConfig) => Promise<WebSearchCheck>;
  /** Persist provider+key. */
  save: (provider: WebSearchConfig['provider'], apiKey: string) => void;
  /** Append a message to the chat history. */
  notify: (output: string) => void;
  /** Phase transition after the outcome: idle on success, key prompt on failure. */
  onOutcome: (phase: 'idle' | 'search_apikey') => void;
  /** True when this run was cancelled (Esc) before the check returned. */
  isStale: () => boolean;
}

export async function submitSearchApiKey(
  value: string,
  provider: WebSearchConfig['provider'],
  deps: SearchSetupDeps,
): Promise<void> {
  const saved = deps.savedConfig();
  const apiKey = value.trim() || (saved?.provider === provider ? saved.apiKey : '');
  if (!apiKey) {
    deps.notify('API key 不能为空。(Esc 取消)');
    return;
  }

  deps.notify(`正在测试 ${provider} key…`);
  const result = await deps.check({ provider, apiKey });
  // Esc during the check: write nothing, touch no phase, show no late result.
  if (deps.isStale()) return;

  if (result.ok) {
    try {
      deps.save(provider, apiKey);
    } catch (error) {
      deps.notify(`✗ 配置写入失败:${error instanceof Error ? error.message : String(error)}\n请重试或手改 ~/.transcode.json`);
      deps.onOutcome('search_apikey');
      return;
    }
    deps.notify(`✓ ${provider} 连通正常(首条结果:${result.firstTitle})。web_search 已启用。`);
    deps.onOutcome('idle');
    return;
  }

  deps.notify(`✗ 测试失败:${result.error}\n请重新输入 key(Esc 取消)`);
  deps.onOutcome('search_apikey');
}
