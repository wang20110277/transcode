import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { quietLibraryNoise } from './library-noise.js';
import { clearRegisteredApiKeys, createModel, registerApiKey, setCustomModel } from './provider.js';

/**
 * Some OpenAI-compatible gateways (SiliconFlow, for one) report usage on
 * EVERY streamed chunk with running totals. @langchain/openai keeps each
 * one in response_metadata.usage, and @langchain/core — which accumulates
 * the chunks internally — cannot merge numbers that differ, so it warns
 * once per field per chunk. Three lines per streamed token reach the
 * terminal. The reply is fine and transcode never reads these numbers.
 */

const NOISE = 'already exists in this message chunk and value has unsupported type';

let configDir: string;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-library-noise-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  delete process.env.TRANSCODE_BASE_URL;
  delete process.env.TRANSCODE_API_KEY;
  clearRegisteredApiKeys();
});
afterEach(async () => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  delete process.env.TRANSCODE_BASE_URL;
  delete process.env.TRANSCODE_API_KEY;
  rmSync(configDir, { recursive: true, force: true });
  await server?.stop?.();
  server = undefined;
});

const REPLY = ['Hi', '!', ' 👋', ' How', ' can', ' I', ' help', '?'];

/** A gateway whose stream carries usage on every chunk, with running totals. */
function startGateway(): string {
  server = Bun.serve({
    port: 0,
    fetch() {
      const promptTokens = 21;
      const frames = REPLY.map((text, i) => {
        const completion = i + 1;
        return `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          model: 'm',
          choices: [{ index: 0, delta: { content: text }, finish_reason: i === REPLY.length - 1 ? 'stop' : null }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completion,
            total_tokens: promptTokens + completion,
            completion_tokens_details: { reasoning_tokens: completion },
          },
        })}\n\n`;
      });
      return new Response([...frames, 'data: [DONE]\n\n'].join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  return `http://127.0.0.1:${server.port!}/v1`;
}

/** Streams one reply from the gateway through the real client; returns what console.warn received. */
async function streamAndCapture(): Promise<{ reply: string; warnings: string[] }> {
  registerApiKey('custom', 'k');
  setCustomModel({ baseUrl: startGateway(), model: 'm' });
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    // Installed on the function in place — exactly what the REPL does after
    // Ink has taken console.warn over.
    const restore = quietLibraryNoise();
    let reply = '';
    try {
      for await (const chunk of await createModel('custom').model.stream('hi')) reply += String(chunk.content);
    } finally {
      restore();
    }
    return { reply, warnings };
  } finally {
    console.warn = original;
  }
}

describe('quietLibraryNoise', () => {
  test('drops the chunk-merge warning and lets every other warning through', () => {
    const seen: unknown[][] = [];
    const target = { warn: (...args: unknown[]) => void seen.push(args) };
    quietLibraryNoise(target);

    target.warn(`field[completion_tokens] ${NOISE}`);
    target.warn('something the user must see', 42);

    expect(seen).toEqual([['something the user must see', 42]]);
  });

  test('restore puts the previous function back without clobbering a later replacement', () => {
    const original = () => {};
    const target = { warn: original };

    const restore = quietLibraryNoise(target);
    expect(target.warn).not.toBe(original);
    restore();
    expect(target.warn).toBe(original);

    const restoreAgain = quietLibraryNoise(target);
    const newer = () => {};
    target.warn = newer; // someone else took over in the meantime
    restoreAgain();
    expect(target.warn).toBe(newer);
  });

  test('a gateway reporting usage on every streamed chunk no longer floods the console', async () => {
    const { reply, warnings } = await streamAndCapture();

    expect(reply).toBe(REPLY.join('')); // the reply itself is untouched
    expect(warnings.filter(line => line.includes(NOISE))).toEqual([]);
  });
});
