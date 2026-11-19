/**
 * Renders a unified diff as an ANSI-colored string for the ink REPL.
 * Added lines are green, removed red, hunk headers cyan; everything else
 * (context, truncation markers) stays uncolored. Output is capped.
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

export function renderDiff(diff: string, maxLines = 40): string {
  if (!diff) return '';
  const lines = diff.split('\n');
  const shown = lines.slice(0, maxLines);
  const colored = shown.map((line) => {
    if (line.startsWith('+')) return `${GREEN}${line}${RESET}`;
    if (line.startsWith('-')) return `${RED}${line}${RESET}`;
    if (line.startsWith('@@')) return `${CYAN}${line}${RESET}`;
    return line;
  });
  if (lines.length > maxLines) {
    colored.push(`... (${lines.length - maxLines} more lines)`);
  }
  return colored.join('\n');
}
