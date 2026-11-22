import { describe, expect, test } from 'bun:test';
import { submitSearchApiKey } from './search-setup.js';
import type { WebSearchCheck, WebSearchConfig } from '../provider/web-search.js';

interface Captured {
  checked?: WebSearchConfig;
  saved?: { provider: string; apiKey: string };
  outcomes: string[];
  notices: string[];
  stale: boolean;
}

function makeDeps(overrides?: {
  checkResult?: WebSearchCheck;
  saveThrows?: boolean;
  saved?: WebSearchConfig | null;
}) {
  const cap: Captured = { outcomes: [], notices: [], stale: false };
  return {
    cap,
    deps: {
      savedConfig: () => overrides?.saved ?? null,
      check: async (cfg: WebSearchConfig) => {
        cap.checked = cfg;
        return overrides?.checkResult ?? { ok: true, firstTitle: 'Alive' };
      },
      save: (provider: string, apiKey: string) => {
        if (overrides?.saveThrows) throw new Error('EACCES: disk full');
        cap.saved = { provider, apiKey };
      },
      notify: (output: string) => cap.notices.push(output),
      onOutcome: (phase: 'idle' | 'search_apikey') => cap.outcomes.push(phase),
      isStale: () => cap.stale,
    },
  };
}

describe('submitSearchApiKey', () => {
  test('空输入 + 已存同商 key → 回车沿用 saved key 发起测试', async () => {
    const { cap, deps } = makeDeps({ saved: { provider: 'tavily', apiKey: 'tvly-old' } });
    await submitSearchApiKey('', 'tavily', deps);
    expect(cap.checked).toEqual({ provider: 'tavily', apiKey: 'tvly-old' });
  });

  test('空输入 + 无已存 → 错误提示,不发起测试,phase 不动', async () => {
    const { cap, deps } = makeDeps();
    await submitSearchApiKey('   ', 'brave', deps);
    expect(cap.checked).toBeUndefined();
    expect(cap.notices[0]).toContain('不能为空');
    expect(cap.outcomes).toEqual([]);
  });

  test('成功 → 写配置 + 成功提示 + 回 idle', async () => {
    const { cap, deps } = makeDeps();
    await submitSearchApiKey('tvly-new', 'tavily', deps);
    expect(cap.saved).toEqual({ provider: 'tavily', apiKey: 'tvly-new' });
    expect(cap.notices.join('\n')).toContain('已启用');
    expect(cap.outcomes).toEqual(['idle']);
  });

  test('测试失败 → 不写配置 + 错误提示 + 回 search_apikey 可重输', async () => {
    const { cap, deps } = makeDeps({ checkResult: { ok: false, error: 'brave HTTP 401: bad key' } });
    await submitSearchApiKey('k', 'brave', deps);
    expect(cap.saved).toBeUndefined();
    expect(cap.notices.join('\n')).toContain('401');
    expect(cap.outcomes).toEqual(['search_apikey']);
  });

  test('Esc 后代次失效(isStale)→ 不写配置、不动 phase、不发迟到的成功消息', async () => {
    const { cap, deps } = makeDeps();
    // Esc fires while the check is in flight: mark stale before completion.
    deps.check = async (cfg: WebSearchConfig) => {
      cap.checked = cfg;
      cap.stale = true;
      return { ok: true, firstTitle: 'late' };
    };
    await submitSearchApiKey('k', 'tavily', deps);
    expect(cap.saved).toBeUndefined();
    expect(cap.outcomes).toEqual([]);
    expect(cap.notices.join('\n')).not.toContain('已启用');
  });

  test('saveConfig 抛异常 → 错误提示 + 回 search_apikey,不向上抛', async () => {
    const { cap, deps } = makeDeps({ saveThrows: true });
    await submitSearchApiKey('k', 'tavily', deps);
    expect(cap.notices.join('\n')).toContain('EACCES');
    expect(cap.outcomes).toEqual(['search_apikey']);
  });
});
