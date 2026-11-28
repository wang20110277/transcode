import { describe, expect, test } from 'bun:test';
import { runCli } from './cli.js';

describe('transcode models', () => {
  test('stdout 输出恰好一行可解析 JSON,含 glmc', async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await runCli(['models']);
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
    }

    const text = writes.join('');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    const models = JSON.parse(text) as Array<{ modelId: string; name: string }>;
    expect(models.some((model) => model.modelId === 'glmc:glm-5.3-flash')).toBe(true);
    expect(models.some((model) => model.modelId === 'glmc')).toBe(false);
  });
});
