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
  test('stdout 一行 JSON,线上拉取假网关模型', async () => {
    const gateway = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/v1/models') {
          return Response.json({ data: [{ id: 'ma' }, { id: 'mb' }] });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const saved: Record<string, string | undefined> = {};
    for (const name of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY', 'KIMI_API_KEY', 'TRANSCODE_API_KEY',
    ]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH,
      JSON.stringify({ profiles: { gw1: { baseUrl: `http://localhost:${gateway.port}/v1`, model: 'mb' } } }),
    );
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
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await gateway.stop();
    }

    const text = writes.join('');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    const models = JSON.parse(text) as Array<{ modelId: string; name: string }>;
    expect(models.some((model) => model.modelId === 'gw1:ma')).toBe(true);
    expect(models.some((model) => model.modelId === 'gw1:mb')).toBe(true);
    expect(models.some((model) => model.modelId === 'glmc')).toBe(false);
  });
});

describe('transcode models 进程退出', () => {
  test('输出生成后进程 promptly 退出(< 2.5s,不吊 5s 定时器)', async () => {
    const gateway = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/v1/models') return Response.json({ data: [{ id: 'ma' }] });
        return new Response('not found', { status: 404 });
      },
    });
    const saved: Record<string, string | undefined> = {};
    for (const name of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY', 'KIMI_API_KEY', 'TRANSCODE_API_KEY',
    ]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    writeFileSync(
      process.env.TRANSCODE_CONFIG_PATH,
      JSON.stringify({ profiles: { gw1: { baseUrl: `http://localhost:${gateway.port}/v1`, model: 'ma' } } }),
    );
    try {
      const started = Date.now();
      const proc = Bun.spawn(['bun', 'bin/transcode.ts', 'models'], {
        cwd: path.resolve(import.meta.dir, '..'),
        env: { ...process.env },
        stdout: 'pipe',
      });
      await proc.exited;
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(2500);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await gateway.stop();
    }
  });
});
