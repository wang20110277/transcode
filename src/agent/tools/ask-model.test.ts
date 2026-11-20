import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAskModelTool } from './ask-model.js';
import { createToolSession } from './session.js';

const calls: Array<{ role: string; prompt: string; images?: string[] }> = [];
const stubAsk = async (role: string, prompt: string, images?: string[]) => {
  calls.push({ role, prompt, images });
  return `answer from ${role}`;
};
const tool = createAskModelTool(stubAsk);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'transcode-askmodel-'));
  calls.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ask_model', () => {
  test('delegates a sub-task to the routed role and returns its answer', async () => {
    const session = createToolSession(dir);
    const output = await tool.execute(
      { role: 'analysis', prompt: '分析这个架构的扩展性' },
      { cwd: dir, session },
    );
    expect(output).toBe('answer from analysis');
    expect(calls[0]?.role).toBe('analysis');
    expect(calls[0]?.prompt).toContain('扩展性');
  });

  test('passes image paths through for vision roles', async () => {
    const session = createToolSession(dir);
    writeFileSync(path.join(dir, 'shot.png'), Buffer.from([1, 2, 3]));
    await tool.execute(
      { role: 'vision', prompt: '截图里什么报错', images: ['shot.png'] },
      { cwd: dir, session },
    );
    expect(calls[0]?.images?.length).toBe(1);
    expect(calls[0]?.images?.[0]).toContain('shot.png');
  });

  test('surfaces routing errors with the configured roles listed', async () => {
    const failing = createAskModelTool(async (role) => {
      throw new Error(`Unknown role "${role}". Configured roles: analysis, design`);
    });
    const session = createToolSession(dir);
    await expect(
      failing.execute({ role: 'x', prompt: 'hi' }, { cwd: dir, session }),
    ).rejects.toThrow(/Unknown role "x".*analysis, design/);
  });
});
