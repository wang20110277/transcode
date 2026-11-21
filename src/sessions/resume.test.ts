import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { saveSession, type SessionRecord } from './store.js';
import { listProjectSessions, resolveResumeTarget, splitResumeArgs } from './resume.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'transcode-resume-test-'));
  process.env.TRANSCODE_SESSIONS_DIR = dir;
});
afterEach(() => {
  delete process.env.TRANSCODE_SESSIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function sample(id: string, title: string, cwd: string): SessionRecord {
  return {
    id,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd,
    model: 'deepseek',
    messages: [new HumanMessage('body')],
  };
}

/** Legacy pre-partitioning layout: flat file directly in the sessions root. */
function writeLegacyFlat(id: string, cwd: string): void {
  writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: `旧-${id}`,
      createdAt: 1,
      updatedAt: 1,
      cwd,
      model: 'deepseek',
      messages: [{ type: 'human', content: 'legacy' }],
    }),
  );
}

describe('listProjectSessions', () => {
  test('only returns sessions whose cwd matches; root-level flat files ignored', () => {
    saveSession(sample('ses_a', '对话A', '/tmp/proj-a'));
    saveSession(sample('ses_b', '对话B', '/tmp/proj-b'));
    writeLegacyFlat('ses_legacy', '/tmp/proj-a');

    const ids = listProjectSessions('/tmp/proj-a').map((s) => s.id).sort();
    expect(ids).toEqual(['ses_a']);
  });

  test('empty project returns an empty list', () => {
    saveSession(sample('ses_b', '对话B', '/tmp/proj-b'));
    expect(listProjectSessions('/tmp/nowhere')).toEqual([]);
  });
});

describe('resolveResumeTarget', () => {
  const list: SessionRecord[] = [
    { ...sample('ses_1', '部署脚本', '/tmp/a'), updatedAt: 30 },
    { ...sample('ses_2', 'README更新', '/tmp/a'), updatedAt: 20 },
    { ...sample('ses_3', '闲聊', '/tmp/a'), updatedAt: 10 },
  ];

  test('numeric resolves through lastIds first, then falls back to list index', () => {
    expect(resolveResumeTarget('2', ['x1', 'ses_3'], list)?.id).toBe('ses_3');
    expect(resolveResumeTarget('1', [], list)?.id).toBe('ses_1');
  });

  test('numeric out of range returns undefined', () => {
    expect(resolveResumeTarget('99', [], list)).toBeUndefined();
  });

  test('exact id beats substring; id and title substrings both match', () => {
    expect(resolveResumeTarget('ses_1', [], list)?.id).toBe('ses_1');
    expect(resolveResumeTarget('README', [], list)?.id).toBe('ses_2');
    expect(resolveResumeTarget('ses_', [], list)?.id).toBe('ses_1');
  });

  test('blank target returns undefined (caller opens the picker)', () => {
    expect(resolveResumeTarget('   ', [], list)).toBeUndefined();
  });

  test('unmatched target returns undefined', () => {
    expect(resolveResumeTarget('不存在', [], list)).toBeUndefined();
  });
});

describe('splitResumeArgs', () => {
  test('second arg is keep-raw only when it is pure digits', () => {
    expect(splitResumeArgs(['部署', '脚本'])).toEqual({ target: '部署 脚本' });
    expect(splitResumeArgs(['3', '5'])).toEqual({ target: '3', keepRaw: '5' });
    expect(splitResumeArgs(['3', '0'])).toEqual({ target: '3', keepRaw: '0' });
    expect(splitResumeArgs(['3', 'abc'])).toEqual({ target: '3 abc' });
    expect(splitResumeArgs(['3'])).toEqual({ target: '3' });
    expect(splitResumeArgs([])).toEqual({ target: '' });
  });
});
