import { describe, expect, test } from 'bun:test';
import { findCommand, getCommands } from './commands.js';

describe('init command registration', () => {
  test('is registered so /help lists it', () => {
    const init = findCommand('init');
    expect(init).toBeDefined();
    expect(init?.description.length).toBeGreaterThan(0);
  });

  test('getCommands exposes it alongside the others', () => {
    const names = getCommands().map((command) => command.name);
    expect(names).toContain('init');
    expect(names).toContain('help');
    expect(names).toContain('exit');
  });
});
