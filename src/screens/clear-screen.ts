/**
 * What /clear writes to the terminal. One newline per screen row scrolls
 * the current screen into the terminal's scrollback — the earlier
 * conversation stays readable by scrolling up — and the two escapes then
 * erase the screen (2J) and put the cursor in its top-left corner (H).
 */
export function clearScreen(rows: number): string {
  return '\n'.repeat(Math.max(rows, 0)) + '\x1b[2J\x1b[H';
}
