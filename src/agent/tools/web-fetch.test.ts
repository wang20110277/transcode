import { describe, expect, test } from 'bun:test';
import {
  FETCH_MAX_CHARS,
  decodeBody,
  htmlToText,
  sniffCharset,
  webFetchTool,
} from './web-fetch.js';
import { createToolSession, type ToolSession } from './session.js';
import type { ToolContext } from './types.js';

const GBK = {
  zhongwen: [0xd6, 0xd0, 0xce, 0xc4], // 中文
  ceshi: [0xb2, 0xe2, 0xca, 0xd4], // 测试
  neirong: [0xc4, 0xda, 0xc8, 0xdd], // 内容
};

function ctx(session: ToolSession): ToolContext {
  return { cwd: session.cwd, session };
}

/** Swap globalThis.fetch for the test; restore in finally. Returns captured request inits. */
async function withFetch(
  impl: typeof fetch,
  run: (calls: RequestInit[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push(init ?? {});
    return impl(input, init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function htmlResponse(body: string | Uint8Array, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

describe('web_fetch pure helpers', () => {
  test('htmlToText:剥 script/style、留正文、提取 <title>、折叠空行', () => {
    const { title, text } = htmlToText(
      '<html><head><title>Docs</title><style>body{}</style></head>' +
        '<body><h1>Heading</h1><script>alert(1)</script><p>Para one</p>' +
        '<noscript>nope</noscript><p>Para two</p></body></html>',
    );
    expect(title).toBe('Docs');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('body{}');
    expect(text).not.toContain('nope');
    expect(text).toContain('Heading');
    expect(text).toContain('Para one');
    expect(text).toContain('Para two');
    expect(text).not.toMatch(/\n{3,}/);
  });

  test('sniffCharset:Content-Type charset 优先;meta charset 兜底;默认 utf-8', () => {
    const metaGbk = new TextEncoder().encode('<meta charset="gbk">');
    const metaEquiv = new TextEncoder().encode(
      '<meta http-equiv="Content-Type" content="text/html; charset=gb2312">',
    );
    expect(sniffCharset('text/html; charset=gbk', metaEquiv)).toBe('gbk');
    expect(sniffCharset('text/html', metaGbk)).toBe('gbk');
    expect(sniffCharset('text/html', metaEquiv)).toBe('gb2312');
    expect(sniffCharset('text/html', new TextEncoder().encode('<p>x</p>'))).toBe('utf-8');
  });

  test('decodeBody:gbk 字节用 TextDecoder 正确解码中文', () => {
    const decoded = decodeBody(new Uint8Array(GBK.zhongwen), 'gbk');
    expect(decoded).toBe('中文');
    // 非法 charset 回落 utf-8 不抛
    expect(decodeBody(new Uint8Array([0x61, 0x62]), 'no-such-charset')).toBe('ab');
  });
});

describe('web_fetch tool', () => {
  test('HTML 响应 → 标题 + 文本 + prompt 原样前置', async () => {
    await withFetch(async () => htmlResponse('<html><head><title>Page T</title></head><body><p>Body text</p></body></html>'), async () => {
      const out = await webFetchTool.execute(
        { url: 'https://example.com/a', prompt: 'find the release date' },
        ctx(createToolSession('/tmp')),
      );
      expect(out).toContain('find the release date');
      expect(out).toContain('Page T');
      expect(out).toContain('Body text');
    });
  });

  test('text/plain 与 application/json 原样返回(截断)', async () => {
    await withFetch(
      async () => new Response('plain bytes here', { headers: { 'content-type': 'text/plain' } }),
      async () => {
        const out = await webFetchTool.execute({ url: 'https://x/f.txt' }, ctx(createToolSession('/tmp')));
        expect(out).toContain('plain bytes here');
      },
    );
    await withFetch(
      async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      async () => {
        const out = await webFetchTool.execute({ url: 'https://x/f.json' }, ctx(createToolSession('/tmp')));
        expect(out).toContain('{"ok":true}');
      },
    );
  });

  test('超 20k 字符截断并注明 "... (truncated)"', async () => {
    const long = 'x'.repeat(FETCH_MAX_CHARS + 5000);
    await withFetch(async () => htmlResponse(`<body><p>${long}</p></body>`), async () => {
      const out = (await webFetchTool.execute({ url: 'https://x/long' }, ctx(createToolSession('/tmp')))) as string;
      expect(out).toContain('... (truncated)');
      expect(out.length).toBeLessThan(FETCH_MAX_CHARS + 200);
    });
  });

  test('403/404 → 返回含状态码的可读错误;fetch 抛超时 → 可读错误,不向上抛', async () => {
    await withFetch(
      async () => new Response('nope', { status: 403, statusText: 'Forbidden' }),
      async () => {
        const out = await webFetchTool.execute({ url: 'https://x/deny' }, ctx(createToolSession('/tmp')));
        expect(out).toContain('403');
      },
    );
    await withFetch(
      async () => {
        throw new Error('The operation was aborted due to timeout');
      },
      async () => {
        const out = await webFetchTool.execute({ url: 'https://x/slow' }, ctx(createToolSession('/tmp')));
        expect(out).toContain('Error');
        expect(out).toContain('aborted');
      },
    );
  });

  test('非文本类型(pdf/图片)→ 返回内容类型与大小提示,不尝试解析', async () => {
    await withFetch(
      async () => new Response(new Uint8Array(1024).fill(1), { headers: { 'content-type': 'application/pdf' } }),
      async () => {
        const out = await webFetchTool.execute({ url: 'https://x/a.pdf' }, ctx(createToolSession('/tmp')));
        expect(out).toContain('application/pdf');
        expect(out).toContain('1024');
        expect(out).not.toContain('Error');
      },
    );
  });

  test('请求头带 transcode UA;gbk 页面端到端解码不乱码', async () => {
    const htmlBytes = new Uint8Array([
      ...new TextEncoder().encode('<html><head><meta charset="gbk"><title>'),
      ...GBK.ceshi,
      ...new TextEncoder().encode('</title></head><body><p>'),
      ...GBK.zhongwen,
      ...GBK.neirong,
      ...new TextEncoder().encode('</p></body></html>'),
    ]);
    await withFetch(
      async () =>
        new Response(htmlBytes, { headers: { 'content-type': 'text/html' } }),
      async (calls) => {
        const out = await webFetchTool.execute({ url: 'https://x/cn' }, ctx(createToolSession('/tmp')));
        const ua = new Headers(calls[0]?.headers as HeadersInit | undefined).get('user-agent') ?? '';
        expect(ua).toMatch(/^Mozilla\/5\.0 \(compatible; transcode\//);
        expect(out).toContain('测试');
        expect(out).toContain('中文内容');
      },
    );
  });
});

describe('htmlToText pathological input', () => {
  test('孤立 < 无 > 的病态输入线性完成(标签剥离不允许二次方冻结)', () => {
    const n = 400_000;
    const start = Date.now();
    const { text } = htmlToText('<'.repeat(n));
    expect(Date.now() - start).toBeLessThan(2_000);
    // 无 > 不构成标签,字符原样保留
    expect(text).toBe('<'.repeat(n));
  });
});
