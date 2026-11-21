import { describe, expect, test } from 'bun:test';
import { historyRule } from './history-rule.js';

describe('historyRule', () => {
  test('fills the terminal width minus a small margin', () => {
    expect(historyRule(80)).toHaveLength(78);
    expect(historyRule(120)).toHaveLength(118);
  });

  test('uses the box-drawing dash and never collapses on narrow terminals', () => {
    expect(historyRule(80).startsWith('─')).toBe(true);
    expect(historyRule(20)).toHaveLength(18);
    expect(historyRule(4).length).toBeGreaterThanOrEqual(10); // clamped floor
    expect(historyRule(0).length).toBeGreaterThanOrEqual(10);
  });
});
