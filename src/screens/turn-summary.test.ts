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
