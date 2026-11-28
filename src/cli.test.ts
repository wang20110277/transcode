import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from './cli.js';

let configDir: string;

beforeEach(() => {
  // #29: isolate from the developer's real ~/.transcode.json.
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-cli-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  writeFileSync(
    process.env.TRANSCODE_CONFIG_PATH,
    JSON.stringify({ apiKeys: { glmc: 'test-key' } }),
  );
});

afterEach(() => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  rmSync(configDir, { recursive: true, force: true });
});

describe('transcode models', () => {
  test('stdout 输出恰好一行可解析 JSON,key 圈定后含 glmc 规格', async () => {
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
