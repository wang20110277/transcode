import { describe, expect, test } from 'bun:test';
import { createTurnStats, recordCall, shouldCollapse, summaryLine } from './turn-summary.js';

describe('turn summary', () => {
  test('records calls per tool name with ok/fail counts', () => {
    const stats = createTurnStats();
    recordCall(stats, 'bash', true);
    recordCall(stats, 'bash', true);
    recordCall(stats, 'read_file', true);
    recordCall(stats, 'edit_file', false);

    expect(stats.calls).toBe(4);
    expect(stats.ok).toBe(3);
    expect(stats.fail).toBe(1);
  });

  test('summary line lists counts by tool with markers', () => {
    const stats = createTurnStats();
    recordCall(stats, 'bash', true);
    recordCall(stats, 'bash', true);
    recordCall(stats, 'read_file', true);
    recordCall(stats, 'edit_file', false);

    const line = summaryLine(stats);
    expect(line).toContain('4 tool calls');
    expect(line).toContain('bash×2');
    expect(line).toContain('read_file×1');
    expect(line).toContain('3✓');
    expect(line).toContain('1✗');
  });

  test('short turns stay expanded, long turns collapse', () => {
    const short = createTurnStats();
    for (let i = 0; i < 3; i++) recordCall(short, 'bash', true);
    expect(shouldCollapse(short)).toBe(false);

    const long = createTurnStats();
    for (let i = 0; i < 4; i++) recordCall(long, 'bash', true);
    expect(shouldCollapse(long)).toBe(true);
  });
});

describe('renderTurnLog', () => {
  test('折叠:summary + "… +N lines (ctrl+o to expand)",N 数实际行数', async () => {
    const { renderTurnLog } = await import('./turn-summary.js');
    const hidden = ['\n⚙ read_file a.ts ✓', '\n⚙ bash npm test ✓\nextra line', '\n⚙ grep foo ✓'];
    expect(renderTurnLog('⚙ 3 tool calls · …', hidden, false)).toBe(
      '⚙ 3 tool calls · …\n… +4 lines (ctrl+o to expand)',
    );
  });

  test('展开:明细可见 + "(ctrl+o to collapse)" 提示', async () => {
    const { renderTurnLog } = await import('./turn-summary.js');
    const out = renderTurnLog('S', ['\n⚙ read_file a.ts ✓', '\n⚙ bash npm test ✓'], true);
    expect(out).toContain('read_file a.ts');
    expect(out).toContain('bash npm test');
    expect(out).toContain('(ctrl+o to collapse)');
  });

  test('无明细时原样返回 summary', async () => {
    const { renderTurnLog } = await import('./turn-summary.js');
    expect(renderTurnLog('S', [], false)).toBe('S');
  });
});
