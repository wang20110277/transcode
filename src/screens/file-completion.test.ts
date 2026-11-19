import { describe, expect, test } from 'bun:test';
import { applyCompletion, filterFiles, mentionQuery } from './file-completion.js';

describe('mentionQuery', () => {
  test('detects a trailing @token', () => {
    expect(mentionQuery('fix @src')).toBe('src');
    expect(mentionQuery('fix @src/a.ts')).toBe('src/a.ts');
  });

  test('empty query right after @', () => {
    expect(mentionQuery('hello @')).toBe('');
    expect(mentionQuery('@')).toBe('');
  });

  test('@ at the very start of the input', () => {
    expect(mentionQuery('@readme')).toBe('readme');
  });

  test('null when @ is glued to a word (like an email)', () => {
    expect(mentionQuery('mail me a@b.com')).toBeNull();
  });

  test('null when the @token is not the trailing segment', () => {
    expect(mentionQuery('see @foo and more')).toBeNull();
    expect(mentionQuery('no mention here')).toBeNull();
  });
});

describe('filterFiles', () => {
  const files = ['src/app.ts', 'src/main.tsx', 'README.md', 'src/util/string.ts', 'a/b/c.ts'];

  test('empty query returns the first files up to the limit', () => {
    expect(filterFiles(files, '', 3)).toEqual(files.slice(0, 3));
  });

  test('substring match, case-insensitive', () => {
    expect(filterFiles(files, 'readme', 8)).toEqual(['README.md']);
    expect(filterFiles(files, 'main', 8)).toEqual(['src/main.tsx']);
  });

  test('substring matches rank before subsequence matches', () => {
    const ranked = filterFiles(['axb.ts', 'ab.ts'], 'ab', 8);
    expect(ranked).toEqual(['ab.ts', 'axb.ts']);
  });

  test('subsequence fallback matches characters in order', () => {
    expect(filterFiles(files, 'abc', 8)).toEqual(['a/b/c.ts']);
  });

  test('no matches yields an empty array', () => {
    expect(filterFiles(files, 'zzzz', 8)).toEqual([]);
  });
});

describe('applyCompletion', () => {
  test('replaces the trailing token with the selected path', () => {
    expect(applyCompletion('fix @src', 'src/app.ts')).toBe('fix @src/app.ts ');
    expect(applyCompletion('@re', 'README.md')).toBe('@README.md ');
  });

  test('leaves the input untouched when no token is active', () => {
    expect(applyCompletion('no token here', 'README.md')).toBe('no token here');
  });
});
