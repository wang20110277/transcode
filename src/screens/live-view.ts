/**
 * Live-region tail windowing. The interactive frame must stay SHORTER than
 * the terminal: once it reaches stdout rows, Ink falls back to
 * clearTerminal + full-history repaint on every render (the flicker this
 * rework kills). During a turn only the tail of the streamed output is
 * shown; the full text lives in a ref and lands in <Static> at turn end.
 *
 * Budgeting counts WRAPPED screen rows (Ink's overflow check uses Yoga
 * layout rows, where wide chars take two columns) — not logical lines.
 */

export interface LiveTail {
  visible: string;
  hidden: number;
}

/** Approximate terminal columns taken by a string: CJK/fullwidth count 2. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch)
      ? 2
      : 1;
  }
  return width;
}

function screenRows(line: string, columns: number): number {
  const width = displayWidth(line);
  return Math.max(1, Math.ceil(width / columns));
}

export function sliceLiveTail(text: string, maxLines: number, columns: number): LiveTail {
  if (!text) return { visible: '', hidden: 0 };
  const budget = Math.max(1, maxLines);
  const cols = Math.max(20, columns);
  const lines = text.split('\n');

  // Walk from the end, accumulating wrapped screen rows until the budget
  // is exhausted. A single line that alone exceeds the budget is still
  // kept (never drop content entirely — the constant margin absorbs it).
  let used = 0;
  let cut = lines.length; // index of first visible line
  for (let i = lines.length - 1; i >= 0; i--) {
    const rows = screenRows(lines[i]!, cols);
    if (used + rows > budget && i !== lines.length - 1) break;
    used += rows;
    cut = i;
  }
  if (cut === 0) return { visible: text, hidden: 0 };
  return { visible: lines.slice(cut).join('\n'), hidden: cut };
}
