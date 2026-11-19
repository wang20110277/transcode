import { describe, expect, test } from 'bun:test';
import { bannerLines } from './banner.js';

describe('bannerLines', () => {
  test('renders a closed rectangle with aligned sides', () => {
    const lines = bannerLines('T R A N S C O D E  ·  Multi-model Agent').split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]!.startsWith('┌')).toBe(true);
    expect(lines[0]!.endsWith('┐')).toBe(true);
    expect(lines[1]!.startsWith('│')).toBe(true);
    expect(lines[1]!.endsWith('│')).toBe(true);
    expect(lines[2]!.startsWith('└')).toBe(true);
    expect(lines[2]!.endsWith('┘')).toBe(true);

    // Every line must have the same display width for the box to close.
    const width = (line: string) => [...line].length;
    expect(width(lines[1]!)).toBe(width(lines[0]!));
    expect(width(lines[2]!)).toBe(width(lines[0]!));
    expect(lines[1]!).toContain('T R A N S C O D E');
  });
});
