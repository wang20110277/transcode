import { describe, expect, test } from 'bun:test';
import { BANNER_TITLE, bannerLines } from './banner.js';

describe('bannerLines', () => {
  test('renders a closed rectangle with aligned sides', () => {
    const lines = bannerLines(BANNER_TITLE).split('\n');
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

  test('the sides still line up where the terminal draws · and similar marks twice as wide', () => {
    // Chinese-locale Windows terminals give ambiguous-width punctuation (·, •, …)
    // two cells, while box-drawing characters keep one. bannerLines() sizes the
    // border by character count, so such a mark makes the title line overhang.
    const code = (ch: string) => ch.charCodeAt(0);
    const columns = (line: string) =>
      [...line].reduce(
        (n, ch) => n + (code(ch) > 0x7e && (code(ch) < 0x2500 || code(ch) > 0x257f) ? 2 : 1),
        0,
      );
    const [top, middle, bottom] = bannerLines(BANNER_TITLE).split('\n');

    expect(columns(middle!)).toBe(columns(top!));
    expect(columns(bottom!)).toBe(columns(top!));
  });
});
