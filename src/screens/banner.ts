/**
 * Closed ASCII banner: the border width is derived from the title so the
 * rectangle always lines up, whatever the title text.
 */
export function bannerLines(title: string, padding = 2): string {
  const inner = ' '.repeat(padding) + title + ' '.repeat(padding);
  const border = '─'.repeat([...inner].length);
  return `┌${border}┐\n│${inner}│\n└${border}┘`;
}
