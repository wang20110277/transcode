import { describe, expect, test } from 'bun:test';
import { fuzzyFilter } from './fuzzy-filter.js';

const MODELS = [
  'gpt-4o-mini',
  'Qwen/Qwen3.8-27B',
  'deepseek-v4-pro',
  'qwen3.5-plus',
  'claude-sonnet-5',
  'MiniMax-M3',
  'glm-5.3-flash',
];

describe('fuzzyFilter', () => {
  test('an empty query keeps the whole list in its original order', () => {
    expect(fuzzyFilter(MODELS, '   ', model => model)).toEqual(MODELS);
  });

  test('matches regardless of case and across separators', () => {
    expect(fuzzyFilter(MODELS, 'qwen27b', model => model)).toEqual(['Qwen/Qwen3.8-27B']);
    expect(fuzzyFilter(MODELS, 'GPT', model => model)).toEqual(['gpt-4o-mini']);
  });

  test('several words must all be found', () => {
    expect(fuzzyFilter(MODELS, 'qwen 27b', model => model)).toEqual(['Qwen/Qwen3.8-27B']);
    expect(fuzzyFilter(MODELS, 'qwen gpt', model => model)).toEqual([]);
  });

  test('tighter matches rank before scattered ones', () => {
    const list = ['xgptx-9', 'gpt-4o', 'g-p-t'];
    expect(fuzzyFilter(list, 'gpt', model => model)).toEqual(['gpt-4o', 'xgptx-9', 'g-p-t']);
  });

  test('equally good matches rank by where the query starts', () => {
    // Both are whole-word matches; the name that starts with the query leads.
    expect(fuzzyFilter(['my-gpt-x', 'gpt-y'], 'gpt', model => model)).toEqual(['gpt-y', 'my-gpt-x']);
  });

  test('a query that matches nothing yields an empty list', () => {
    expect(fuzzyFilter(MODELS, 'zzz', model => model)).toEqual([]);
  });
});
