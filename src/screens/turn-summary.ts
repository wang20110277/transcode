/**
 * Per-turn tool call statistics for the REPL: decides whether a turn's tool
 * log collapses into one summary line and formats that line.
 */

export interface TurnStats {
  calls: number;
  ok: number;
  fail: number;
  byName: Map<string, number>;
}

export function createTurnStats(): TurnStats {
  return { calls: 0, ok: 0, fail: 0, byName: new Map() };
}

export function recordCall(stats: TurnStats, name: string, ok: boolean): void {
  stats.calls++;
  if (ok) stats.ok++;
  else stats.fail++;
  stats.byName.set(name, (stats.byName.get(name) ?? 0) + 1);
}

/** Turns with more than 3 tool calls collapse into a single summary line. */
export function shouldCollapse(stats: TurnStats): boolean {
  return stats.calls > 3;
}

export function summaryLine(stats: TurnStats): string {
  if (stats.calls === 0) return '';
  const parts = [...stats.byName.entries()].map(([name, count]) => `${name}×${count}`);
  const markers = `${stats.ok}✓${stats.fail > 0 ? ` ${stats.fail}✗` : ''}`;
  return `⚙ ${stats.calls} tool calls · ${parts.join(' ')} · ${markers}`;
}

/**
 * Collapsed turn line, stamped at creation time (static entries print once
 * and never re-render): summary plus the expand affordance.
 */
export function renderCollapsed(summary: string, hiddenLines: string[]): string {
  if (hiddenLines.length === 0) return summary;
  const count = hiddenLines
    .flatMap((line) => line.split('\n'))
    .filter((line) => line.trim().length > 0).length;
  return `${summary}\n… +${count} lines (ctrl+o 展开明细)`;
}
