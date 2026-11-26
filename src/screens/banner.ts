/**
 * Closed ASCII banner: the border width is derived from the title so the
 * rectangle always lines up, whatever the title text.
 */
export function bannerLines(title: string, padding = 2): string {
  const inner = ' '.repeat(padding) + title + ' '.repeat(padding);
  const border = '─'.repeat([...inner].length);
  return `┌${border}┐\n│${inner}│\n└${border}┘`;
}

/**
 * Plain ASCII only. The border is sized by character count, so a mark that
 * some terminal draws twice as wide (· is one on Chinese-locale Windows)
 * pushes the title line's right border out by a column.
 */
export const BANNER_TITLE = 'T R A N S C O D E  |  Multi-Model Agent';

/**
 * The brand green, sampled from the swoosh in trans.jpg: the colour of the
 * logo box and of what the user typed in the transcript.
 */
export const BRAND_GREEN = '#0cbe66';
