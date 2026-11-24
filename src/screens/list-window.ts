/**
 * Viewport for a navigable list longer than the terminal (a gateway can
 * serve 300+ models). Only the window is rendered, so the highlighted row is
 * always on screen and the interactive frame keeps fitting the terminal.
 */

export interface ListWindow {
  /** Index of the first row to draw. */
  start: number;
  /** Index just past the last row to draw. */
  end: number;
  /** Rows hidden above / below the window. */
  before: number;
  after: number;
}

/**
 * The rows to draw for a list of `length` items with the cursor at `cursor`
 * and room for `height` rows. The window stays put while the cursor is in
 * its first half, then follows one row per step (the cursor rides the
 * middle), and stops at the end of the list.
 */
export function listWindow(length: number, cursor: number, height: number): ListWindow {
  const size = Math.min(Math.max(height, 1), length);
  const current = Math.min(Math.max(cursor, 0), Math.max(length - 1, 0));
  const start = Math.min(Math.max(current - Math.floor((size - 1) / 2), 0), length - size);
  const end = start + size;
  return { start, end, before: start, after: length - end };
}
