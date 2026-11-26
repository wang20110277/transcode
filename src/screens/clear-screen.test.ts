import { describe, expect, test } from 'bun:test';
import { clearScreen } from './clear-screen.js';

describe('clearScreen', () => {
  test('scrolls the screen into the scrollback with one newline per row, then clears it', () => {
    expect(clearScreen(24)).toBe('\n'.repeat(24) + '\x1b[2J\x1b[H');
  });

  test('a terminal of unknown height still clears', () => {
    expect(clearScreen(0)).toBe('\x1b[2J\x1b[H');
    expect(clearScreen(-1)).toBe('\x1b[2J\x1b[H');
  });
});
