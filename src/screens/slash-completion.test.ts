import { describe, expect, test } from 'bun:test';
import {
  applySlashCompletion,
  filterSlashCommands,
  slashQuery,
} from './slash-completion.js';

const CMDS = [
  { name: 'help', description: 'Show help' },
  { name: 'models', description: 'List and switch model' },
  { name: 'new', description: 'Start a new conversation' },
];

describe('slashQuery', () => {
  test('extracts the command prefix after the slash', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/mo')).toBe('mo');
    expect(slashQuery('/models')).toBe('models');
  });

  test('returns null for non-slash input', () => {
    expect(slashQuery('')).toBeNull();
    expect(slashQuery('hello')).toBeNull();
    expect(slashQuery('a /b')).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  test('bare slash lists every command', () => {
    expect(filterSlashCommands('/', CMDS)).toEqual(CMDS);
  });

  test('prefix-matches case-insensitively', () => {
    expect(filterSlashCommands('/MO', CMDS)).toEqual([CMDS[1]]);
  });

  test('no matches (or non-slash input) yields an empty list', () => {
    expect(filterSlashCommands('/xyz', CMDS)).toEqual([]);
    expect(filterSlashCommands('/plan task', CMDS)).toEqual([]);
    expect(filterSlashCommands('hello', CMDS)).toEqual([]);
  });

  test('a lone exact match suppresses the popup (Enter should submit)', () => {
    // Typing the full command name hides the popup so Enter runs the
    // command instead of completing it.
    expect(filterSlashCommands('/models', CMDS)).toEqual([]);
    // …while a shared or partial prefix keeps it visible.
    expect(filterSlashCommands('/mo', CMDS)).toEqual([CMDS[1]]);
    expect(filterSlashCommands('/n', CMDS)).toEqual([CMDS[2]]);
  });
});

describe('applySlashCompletion', () => {
  test('replaces the slash token with the selected command plus a space', () => {
    expect(applySlashCompletion('/mo', 'models')).toBe('/models ');
    expect(applySlashCompletion('/', 'plan')).toBe('/plan ');
  });

  test('leaves non-slash input untouched', () => {
    expect(applySlashCompletion('hello', 'models')).toBe('hello');
  });
});
