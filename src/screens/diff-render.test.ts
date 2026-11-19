import { describe, expect, test } from 'bun:test';
import { renderDiff } from './diff-render.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

describe('renderDiff', () => {
  test('colors added, removed and hunk-header lines', () => {
    const diff = '@@ -1,2 +1,2 @@\n context\n-old\n+new';
    const out = renderDiff(diff);
    const lines = out.split('\n');
    expect(lines[0]).toBe(`${CYAN}@@ -1,2 +1,2 @@${RESET}`);
    expect(lines[1]).toBe(' context');
    expect(lines[2]).toBe(`${RED}-old${RESET}`);
    expect(lines[3]).toBe(`${GREEN}+new${RESET}`);
  });

  test('caps output and reports omitted lines', () => {
    const diff = Array.from({ length: 6 }, (_, i) => `+line${i}`).join('\n');
    const out = renderDiff(diff, 3);
    expect(out.split('\n').length).toBe(4);
    expect(out).toContain('... (3 more lines)');
  });

  test('empty diff renders empty', () => {
    expect(renderDiff('')).toBe('');
  });

  test('neutral lines like truncation markers stay uncolored', () => {
    const out = renderDiff('+a\n... (+12 more lines)');
    const lines = out.split('\n');
    expect(lines[1]).toBe('... (+12 more lines)');
  });
});
