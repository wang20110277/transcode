/**
 * Live-region tail windowing. The interactive frame must stay SHORTER than
 * the terminal: once it reaches stdout rows, Ink falls back to
 * clearTerminal + full-history repaint on every render (the flicker this
 * rework kills). During a turn only the tail of the streamed output is
 * shown; the full text lives in a ref and lands in <Static> at turn end.
 */

export interface LiveTail {
  visible: string;
  hidden: number;
}

export function sliceLiveTail(text: string, maxLines: number): LiveTail {
  if (!text) return { visible: '', hidden: 0 };
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { visible: text, hidden: 0 };
  const hidden = lines.length - maxLines;
  return { visible: lines.slice(hidden).join('\n'), hidden };
}
