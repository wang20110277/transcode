import { describe, expect, test } from 'bun:test';
import { normalizeWebSearchConfig, runWebSearch, webSearchConfigWarning } from './web-search.js';

describe('normalizeWebSearchConfig', () => {
  test('tavily/brave 合法通过;段缺失 → null 且无警告', () => {
    expect(normalizeWebSearchConfig({ provider: 'tavily', apiKey: 'tvly-1' })).toEqual({
      provider: 'tavily',
      apiKey: 'tvly-1',
    });
    expect(normalizeWebSearchConfig({ provider: 'brave', apiKey: 'BSA2' })).toEqual({
      provider: 'brave',
      apiKey: 'BSA2',
    });
    expect(normalizeWebSearchConfig(undefined)).toBeNull();
    expect(normalizeWebSearchConfig(null)).toBeNull();
    expect(webSearchConfigWarning(undefined)).toBeNull();
  });

  test('provider 拼错/key 空 → null 且警告含 "/search" 提示', () => {
    expect(normalizeWebSearchConfig({ provider: 'google', apiKey: 'x' })).toBeNull();
    expect(normalizeWebSearchConfig({ provider: 'tavily', apiKey: '  ' })).toBeNull();
    expect(normalizeWebSearchConfig({ provider: 'tavily' })).toBeNull();
    const warning = webSearchConfigWarning({ provider: 'google', apiKey: 'x' });
    expect(warning).toContain('/search');
    expect(warning).toContain('google');
    expect(webSearchConfigWarning({ provider: 'tavily' })).toContain('/search');
  });
});

describe('runWebSearch adapters', () => {
  test('tavily:按 spec 端点/体调用,映射 title/url/snippet', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    const hits = await runWebSearch(
      { provider: 'tavily', apiKey: 'tvly-9' },
      'bun release notes',
      5,
      (async (input: any, init?: any) => {
        seenUrl = String(input);
        seenInit = init ?? {};
        return new Response(
          JSON.stringify({
            results: [
              { title: 'Bun v1.3', url: 'https://bun.sh/blog/bun-v1.3', content: 'Bun 1.3 release' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    );
    expect(seenUrl).toBe('https://api.tavily.com/search');
    const body = JSON.parse(String(seenInit.body));
    expect(body).toEqual({ api_key: 'tvly-9', query: 'bun release notes', max_results: 5 });
    expect(hits).toEqual([
      { title: 'Bun v1.3', url: 'https://bun.sh/blog/bun-v1.3', snippet: 'Bun 1.3 release' },
    ]);
  });

  test('brave:X-Subscription-Token 头 + q/count 参数,结果映射', async () => {
    let seenUrl = '';
    let seenHeaders: Headers | null = null;
    const hits = await runWebSearch(
      { provider: 'brave', apiKey: 'BSA7' },
      'ink react terminal',
      3,
      (async (input: any, init?: any) => {
        seenUrl = String(input);
        seenHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            web: {
              results: [
                { title: 'Ink', url: 'https://github.com/vadimdemedes/ink', description: 'React for CLIs' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    );
    expect(seenUrl).toContain('https://api.search.brave.com/res/v1/web/search?');
    expect(seenUrl).toContain('q=ink+react+terminal');
    expect(seenUrl).toContain('count=3');
    expect(seenHeaders!.get('x-subscription-token')).toBe('BSA7');
    expect(hits).toEqual([
      { title: 'Ink', url: 'https://github.com/vadimdemedes/ink', snippet: 'React for CLIs' },
    ]);
  });

  test('HTTP 401/400 → 抛含状态与 API 报错文案的 Error;未知 provider 也抛', async () => {
    const deny = (async () =>
      new Response('{"detail":"Invalid API key"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    await expect(
      runWebSearch({ provider: 'tavily', apiKey: 'bad' }, 'q', 5, deny),
    ).rejects.toThrow(/401/);
    await expect(
      runWebSearch({ provider: 'tavily', apiKey: 'bad' }, 'q', 5, deny),
    ).rejects.toThrow(/Invalid API key/);
    await expect(
      runWebSearch({ provider: 'nope' as never, apiKey: 'x' }, 'q', 5, deny),
    ).rejects.toThrow(/nope/);
  });
});

describe('web search setup helpers', () => {
  test('saveWebSearchConfig:写 webSearch 段且不覆盖其它段', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { loadConfig } = await import('../config.js');
    const { saveWebSearchConfig } = await import('./web-search.js');
    const root = mkdtempSync(path.join(tmpdir(), 'transcode-ws-save-'));
    const configPath = path.join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ apiKeys: { glm: 'g-1' }, model: 'glm' }));
    process.env.TRANSCODE_CONFIG_PATH = configPath;
    try {
      saveWebSearchConfig('tavily', 'tvly-3');
      const saved = JSON.parse((await import('node:fs')).readFileSync(configPath, 'utf8'));
      expect(saved).toEqual({
        apiKeys: { glm: 'g-1' },
        model: 'glm',
        webSearch: { provider: 'tavily', apiKey: 'tvly-3' },
      });
      expect(loadConfig().webSearch).toEqual({ provider: 'tavily', apiKey: 'tvly-3' });
    } finally {
      delete process.env.TRANSCODE_CONFIG_PATH;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('checkWebSearch 成功:固定测试查询,首条 title 返回', async () => {
    const { checkWebSearch } = await import('./web-search.js');
    let seenBody = '';
    const result = await checkWebSearch(
      { provider: 'tavily', apiKey: 'tvly-8' },
      (async (_input: any, init?: any) => {
        seenBody = String(init?.body ?? '');
        return new Response(
          JSON.stringify({ results: [{ title: 'Alive', url: 'https://x/1', content: 's' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    );
    expect(result).toEqual({ ok: true, firstTitle: 'Alive' });
    expect(JSON.parse(seenBody).query).toBe('transcode connectivity check');
    expect(JSON.parse(seenBody).max_results).toBe(1);
  });

  test('checkWebSearch 失败:API 报错进 error,不抛异常', async () => {
    const { checkWebSearch } = await import('./web-search.js');
    const result = await checkWebSearch(
      { provider: 'brave', apiKey: 'bad' },
      (async () =>
        new Response('{"error":"Invalid key"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('401');
      expect(result.error).toContain('Invalid key');
    }
  });
});

describe('web search request signals', () => {
  test('两适配器 fetch 带 AbortSignal,外部 signal abort 可传导(Esc 可取消)', async () => {
    const { runWebSearch } = await import('./web-search.js');
    for (const provider of ['tavily', 'brave'] as const) {
      let captured: AbortSignal | undefined;
      const fetchImpl = (async (_input: any, init?: any) => {
        captured = init?.signal;
        return new Response(
          JSON.stringify(
            provider === 'tavily'
              ? { results: [{ title: 'T', url: 'u', content: 'c' }] }
              : { web: { results: [{ title: 'T', url: 'u', description: 'c' }] } },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;
      const outer = new AbortController();
      const pending = runWebSearch({ provider, apiKey: 'k' }, 'q', 5, fetchImpl, outer.signal);
      expect(captured).toBeInstanceOf(AbortSignal);
      expect(captured!.aborted).toBe(false);
      outer.abort();
      expect(captured!.aborted).toBe(true);
      await pending;
    }
  });
});
