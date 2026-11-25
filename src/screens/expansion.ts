/**
 * The ctrl+o panel. Printed history never changes, so the detail of a folded
 * turn cannot be expanded in place and taken back again: it is shown in the
 * live region instead, above the input box, where it can open and close
 * freely. These helpers are the pure part — which folded turn is shown and
 * how much of its detail fits; the REPL only wires keys and rendering.
 */
import { sliceLiveTail, type LiveTail } from './live-view.js';

/** A transcript entry, as far as the panel is concerned. */
export interface FoldableEntry {
  /** Tool-log detail hidden behind the collapse summary; absent when the turn is not folded. */
  hiddenLines?: string[];
}

/** The panel's answer to ctrl+o when nothing is folded. */
export const NOTHING_FOLDED = -1;

const isFolded = (entry: FoldableEntry | undefined): boolean => (entry?.hiddenLines?.length ?? 0) > 0;

/** Index of the latest entry that still has hidden detail; NOTHING_FOLDED when there is none. */
export function latestFoldedIndex(history: readonly FoldableEntry[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (isFolded(history[i])) return i;
  }
  return NOTHING_FOLDED;
}

/**
 * Index of the next folded entry in `direction` (-1 older, +1 newer),
 * skipping entries that are not folded. Stays on `from` at either end.
 */
export function stepFoldedIndex(history: readonly FoldableEntry[], from: number, direction: -1 | 1): number {
  for (let i = from + direction; i >= 0 && i < history.length; i += direction) {
    if (isFolded(history[i])) return i;
  }
  return from;
}

/** How many folded turns are newer than the one at `index`: 0 for the most recent one. */
function rankFromLatest(history: readonly FoldableEntry[], index: number): number {
  let rank = 0;
  for (let i = index + 1; i < history.length; i++) {
    if (isFolded(history[i])) rank++;
  }
  return rank;
}

/** Title line of the panel for the folded turn at `index`. */
export function expansionTitle(history: readonly FoldableEntry[], index: number): string {
  const rank = rankFromLatest(history, index);
  if (rank === 0) return '⚙ 展开明细 · 最近一个折叠回合';
  const total = history.filter(isFolded).length;
  return `⚙ 展开明细 · 倒数第 ${rank + 1} 个折叠回合（共 ${total} 个）`;
}

/**
 * The hidden detail of one folded turn, keeping only the tail that fits in
 * `maxRows` screen rows (wrapped rows counted at `columns`) and counting
 * the lines left out above it.
 */
export function windowedDetail(hiddenLines: readonly string[], maxRows: number, columns: number): LiveTail {
  // Each hidden line starts with the newline that separated it in the live
  // stream; together they leave a blank line at both ends of the detail.
  return sliceLiveTail(hiddenLines.join('').replace(/^\n+|\n+$/g, ''), maxRows, columns);
}
