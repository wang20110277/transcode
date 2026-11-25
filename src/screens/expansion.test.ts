import { describe, expect, test } from 'bun:test';
import {
  NOTHING_FOLDED,
  expansionTitle,
  latestFoldedIndex,
  stepFoldedIndex,
  windowedDetail,
} from './expansion.js';

/** Transcript entries as the panel sees them: only the hidden detail matters here. */
const folded = (...lines: string[]) => ({ hiddenLines: lines });
const plain = { hiddenLines: undefined };

describe('latestFoldedIndex', () => {
  test('is the last entry that still has hidden detail', () => {
    const history = [folded('a'), plain, folded('b'), plain, folded('c'), plain];
    expect(latestFoldedIndex(history)).toBe(4);
  });

  test('is NOTHING_FOLDED when no entry is folded, also for an empty transcript', () => {
    expect(latestFoldedIndex([plain, plain])).toBe(NOTHING_FOLDED);
    expect(latestFoldedIndex([])).toBe(NOTHING_FOLDED);
  });
});

describe('stepFoldedIndex', () => {
  // Two folded turns, with plain entries around and between them.
  const history = [folded('a'), plain, plain, folded('b'), plain];

  test('moves to the next folded entry in that direction, skipping the others', () => {
    expect(stepFoldedIndex(history, 3, -1)).toBe(0);
    expect(stepFoldedIndex(history, 0, 1)).toBe(3);
  });

  test('stays where it is at either end', () => {
    expect(stepFoldedIndex(history, 0, -1)).toBe(0);
    expect(stepFoldedIndex(history, 3, 1)).toBe(3);
  });
});

describe('expansionTitle', () => {
  test('names the most recent folded turn, and counts from the end for the others', () => {
    const history = [folded('a'), folded('b'), plain, folded('c')];
    expect(expansionTitle(history, 3)).toBe('⚙ 展开明细 · 最近一个折叠回合');
    expect(expansionTitle(history, 1)).toBe('⚙ 展开明细 · 倒数第 2 个折叠回合（共 3 个）');
    expect(expansionTitle(history, 0)).toBe('⚙ 展开明细 · 倒数第 3 个折叠回合（共 3 个）');
  });
});

describe('windowedDetail', () => {
  test('joins the hidden lines and drops the blank lines they carry at both ends', () => {
    expect(windowedDetail(['\n⚙ a ✓', '\n⚙ b ✓'], 20, 80)).toEqual({
      visible: '⚙ a ✓\n⚙ b ✓',
      hidden: 0,
    });
  });

  test('keeps only the tail that fits and counts what it left out', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `\n⚙ step ${i + 1} ✓`);
    expect(windowedDetail(lines, 3, 80)).toEqual({
      visible: '⚙ step 4 ✓\n⚙ step 5 ✓\n⚙ step 6 ✓',
      hidden: 3,
    });
  });

  test('an empty detail is an empty view', () => {
    expect(windowedDetail([], 20, 80)).toEqual({ visible: '', hidden: 0 });
  });
});
