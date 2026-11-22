import { z } from 'zod';
import type { AgentTool } from './types.js';
import { VERSION } from '../../version.js';

/**
 * Zero-dependency web fetch: native fetch + charset sniffing + tag-stripping
 * HTML extraction. Content-type dispatch decides between extraction, raw
 * text, and a binary hint.
 */

export const FETCH_MAX_BYTES = 512 * 1024;
export const FETCH_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = `Mozilla/5.0 (compatible; transcode/${VERSION})`;
const TRUNCATED_NOTE = '... (truncated)';

/** Content-Type header charset first, then <meta charset> in the first 2KB, else utf-8. */
export function sniffCharset(contentType: string, body: Uint8Array): string {
  const header = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  if (header) return header[1].toLowerCase();
  const head = new TextDecoder('latin1').decode(body.slice(0, 2048));
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (meta) return meta[1].toLowerCase();
  return 'utf-8';
}

/** Decode with the sniffed charset; an unsupported charset falls back to utf-8. */
export function decodeBody(body: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Strip head/script/style/noscript noise, tags to whitespace, collapse blank lines. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') || null : null;
  const text = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return { title, text };
}

function isHtmlType(contentType: string): boolean {
  return /html/i.test(contentType);
}

function isTextualType(contentType: string): boolean {
  return contentType === '' || /^text\//i.test(contentType) || /(json|xml|javascript|html)/i.test(contentType);
}

export const webFetchTool: AgentTool = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return readable text: HTML pages are stripped to text with their ' +
    'title, text/plain and JSON pass through, binary types return a type/size hint. ' +
    'Use it to read docs, API responses and raw files. Handles gbk/gb2312 pages.',
  kind: 'fetch',
  isMutating: false,
  schema: z.object({
    url: z.string().url().describe('Absolute URL to fetch'),
    prompt: z.string().optional().describe('What to look for on the page (guidance only)'),
  }),
  title: (input) => `web_fetch ${input.url}`,
  async execute(input) {
    const url = String(input.url);
    const prompt = input.prompt ? String(input.prompt) : '';
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        return `Error: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} fetching ${url}`;
      }
      const contentType = res.headers.get('content-type') ?? '';
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > FETCH_MAX_BYTES) bytes = bytes.slice(0, FETCH_MAX_BYTES);
      if (!isTextualType(contentType)) {
        return `Fetched ${url}: ${contentType || 'unknown content type'}, ${bytes.length} bytes (binary; not extracted).`;
      }
      let text = decodeBody(bytes, sniffCharset(contentType, bytes));
      let title: string | null = null;
      if (isHtmlType(contentType) || /^\s*<(?:!doctype|html)/i.test(text)) {
        const parsed = htmlToText(text);
        title = parsed.title;
        text = parsed.text;
      }
      if (text.length > FETCH_MAX_CHARS) {
        text = `${text.slice(0, FETCH_MAX_CHARS)}\n${TRUNCATED_NOTE}`;
      }
      return `${prompt ? `Reading guide: ${prompt}\n\n` : ''}${title ? `# ${title}\n` : ''}${text}`;
    } catch (error) {
      return `Error: web_fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
