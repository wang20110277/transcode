import { describe, expect, test } from 'bun:test';
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolSession, type ToolSession } from './session.js';
import type { ToolContext } from './types.js';
import { webSearchTool } from './web-search.js';

function ctx(session: ToolSession): ToolContext {
  return { cwd: session.cwd, session };
}

/** Point TRANSCODE_USER-style config at a temp file with optional webSearch section. */
async function withConfig(webSearch: unknown, run: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'transcode-ws-config-'));
  const configPath = path.join(root, 'config.json');
  const raw: Record<string, unknown> = { apiKeys: { glm: 'keep-me' } };
  if (webSearch !== undefined) raw.webSearch = webSearch;
  writeFileSync(configPath, JSON.stringify(raw));
  process.env.TRANSCODE_CONFIG_PATH = configPath;
  try {
    await run();
  } finally {
    delete process.env.TRANSCODE_CONFIG_PATH;
    rmSync(root, { recursive: true, force: true });
  }
}

describe('web_search tool', () => {
  test('isEnabled 按当前 loadConfig 返回;execute 输出 "title — url\\nsnippet" 列表', async () => {
    await withConfig({ provider: 'tavily', apiKey: 'tvly-5' }, async () => {
      expect(webSearchTool.isEnabled?.()).toBe(true);

      const original = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            results: [
              { title: 'Hit A', url: 'https://a.dev/x', content: 'snippet A' },
              { title: 'Hit B', url: 'https://b.dev/y', content: 'snippet B' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch;
      try {
        const out = await webSearchTool.execute({ query: 'test q' }, ctx(createToolSession('/tmp')));
        expect(out).toContain('Hit A — https://a.dev/x');
        expect(out).toContain('snippet A');
        expect(out).toContain('Hit B — https://b.dev/y');
        void original;
      } finally {
        globalThis.fetch = original;
      }
    });

    await withConfig(undefined, async () => {
      expect(webSearchTool.isEnabled?.()).toBe(false);
    });
  });

  test('未配置时 execute 返回 not configured 可读错误(兜底路径);坏配置也如此', async () => {
    await withConfig(undefined, async () => {
      const out = await webSearchTool.execute({ query: 'x' }, ctx(createToolSession('/tmp')));
      expect(out).toContain('not configured');
      expect(out).toContain('/search');
    });
    await withConfig({ provider: 'googl', apiKey: '' }, async () => {
      const out = await webSearchTool.execute({ query: 'x' }, ctx(createToolSession('/tmp')));
      expect(out).toContain('not configured');
    });
  });
});

void fs;

describe('web_search cancellation wiring', () => {
  test('execute 把 ctx.signal 接进搜索请求(Esc 打断子代理/主回合)', async () => {
    await withConfig({ provider: 'tavily', apiKey: 'tvly-5' }, async () => {
      let captured: AbortSignal | undefined;
      const original = globalThis.fetch;
      globalThis.fetch = (async (_i: any, init?: any) => {
        captured = init?.signal;
        return new Response(
          JSON.stringify({ results: [{ title: 'T', url: 'u', content: 'c' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;
      try {
        const controller = new AbortController();
        const session = createToolSession('/tmp');
        await webSearchTool.execute({ query: 'q' }, { cwd: session.cwd, session, signal: controller.signal });
        expect(captured).toBeInstanceOf(AbortSignal);
        controller.abort();
        expect(captured!.aborted).toBe(true);
      } finally {
        globalThis.fetch = original;
      }
    });
  });
});
