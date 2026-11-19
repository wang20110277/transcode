import { describe, expect, test } from 'bun:test';
import { lineDiff } from './diff.js';

describe('lineDiff', () => {
  test('returns empty string for identical content', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nb\nc\n')).toBe('');
    expect(lineDiff('', '')).toBe('');
  });

  test('shows a middle line change with full context on a small file', () => {
    const diff = lineDiff('a\nb\nc\n', 'a\nX\nc\n');
    expect(diff).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+X\n c');
  });

  test('shows an insertion', () => {
    const diff = lineDiff('a\nb\n', 'a\nX\nb\n');
    expect(diff).toBe('@@ -1,2 +1,3 @@\n a\n+X\n b');
  });

  test('shows a deletion', () => {
    const diff = lineDiff('a\nb\nc\n', 'a\nc\n');
    expect(diff).toBe('@@ -1,3 +1,2 @@\n a\n-b\n c');
  });

  test('insertion at the very top shows following context lines', () => {
    const diff = lineDiff('b\nc\n', 'X\nb\nc\n');
    expect(diff).toBe('@@ -1,2 +1,3 @@\n+X\n b\n c');
  });

  test('insertion into empty content uses the zero-count old range', () => {
    expect(lineDiff('', 'X\n')).toBe('@@ -0,0 +1,1 @@\n+X');
  });

  test('limits context to 3 lines around a change', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `l${i + 1}`);
    const changed = [...lines];
    changed[5] = 'CHANGED'; // l6
    const diff = lineDiff(`${lines.join('\n')}\n`, `${changed.join('\n')}\n`);

    expect(diff.startsWith('@@ -3,7 +3,7 @@')).toBe(true);
    expect(diff).toContain('-l6');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain(' l3');
    expect(diff).toContain(' l9');
    expect(diff).not.toContain(' l2');
    expect(diff).not.toContain(' l10');
  });

  test('splits distant changes into separate hunks', () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
    const next = [...old];
    next[1] = 'A'; // l2
    next[27] = 'B'; // l28 — 25 lines apart, beyond merge distance
    const diff = lineDiff(`${old.join('\n')}\n`, `${next.join('\n')}\n`);

    const hunks = diff.split('\n').filter((line) => line.startsWith('@@'));
    expect(hunks.length).toBe(2);
    expect(diff).toContain('+A');
    expect(diff).toContain('+B');
  });

  test('merges changes within the merge distance into one hunk', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const next = [...old];
    next[0] = 'A';
    next[8] = 'I'; // gap of 7 context lines < 2*context+2 → merged
    const diff = lineDiff(`${old.join('\n')}\n`, `${next.join('\n')}\n`);

    const hunks = diff.split('\n').filter((line) => line.startsWith('@@'));
    expect(hunks.length).toBe(1);
  });

  test('falls back to whole-block replace when the change is huge', () => {
    const old = Array.from({ length: 2500 }, (_, i) => `old${i}`);
    const next = Array.from({ length: 2500 }, (_, i) => `new${i}`);
    const diff = lineDiff(`${old.join('\n')}\n`, `${next.join('\n')}\n`);

    expect(diff.startsWith('@@ -1,2500 +1,2500 @@')).toBe(true);
    expect(diff.split('\n').filter((l) => l.startsWith('-')).length).toBe(2500);
    expect(diff.split('\n').filter((l) => l.startsWith('+')).length).toBe(2500);
  });
});
