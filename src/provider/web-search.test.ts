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
