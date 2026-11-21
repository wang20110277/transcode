import { describe, expect, test } from 'bun:test';
import { planAutoUpdate } from './upgrade.js';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function defaults(overrides: Partial<Parameters<typeof planAutoUpdate>[0]> = {}) {
  return {
    current: '0.4.0',
    latest: '0.5.0',
    target: 'latest',
    enabled: true,
    lastCheck: 0,
    now: NOW,
    ...overrides,
  };
}

describe('planAutoUpdate', () => {
  test('envSkip wins over everything, including disabled', () => {
    const plan = planAutoUpdate(defaults({ envSkip: true, enabled: false, lastCheck: NOW }));
    expect(plan).toEqual({ action: 'skip', reason: 'env-skip' });
  });

  test('disabled skips regardless of throttle state', () => {
    expect(planAutoUpdate(defaults({ enabled: false }))).toEqual({
      action: 'skip',
      reason: 'disabled',
    });
  });

  test('throttled while the interval has not fully elapsed (even by 1ms)', () => {
    expect(
      planAutoUpdate(defaults({ lastCheck: NOW - 24 * HOUR + 1 })),
    ).toEqual({ action: 'skip', reason: 'throttled' });
  });

  test('the boundary elapses exactly at now - lastCheck === interval', () => {
    const plan = planAutoUpdate(defaults({ lastCheck: NOW - 24 * HOUR }));
    expect(plan).toEqual({ action: 'install', spec: '@trans-ai/trans-code@latest', from: '0.4.0', to: '0.5.0' });
  });

  test('intervalHours overrides the default 24h window', () => {
    expect(
      planAutoUpdate(defaults({ lastCheck: NOW - 2 * HOUR, intervalHours: 1 })),
    ).toEqual({ action: 'install', spec: '@trans-ai/trans-code@latest', from: '0.4.0', to: '0.5.0' });
  });

  test('latest mode: unreachable registry skips silently (unknown-latest)', () => {
    expect(planAutoUpdate(defaults({ latest: null }))).toEqual({
      action: 'skip',
      reason: 'unknown-latest',
    });
  });

  test('latest mode: already current skips (up-to-date)', () => {
    expect(planAutoUpdate(defaults({ latest: '0.4.0' }))).toEqual({
      action: 'skip',
      reason: 'up-to-date',
    });
  });

  test('latest mode: newer version installs the full package spec', () => {
    expect(planAutoUpdate(defaults({ latest: '0.5.0' }))).toEqual({
      action: 'install',
      spec: '@trans-ai/trans-code@latest',
      from: '0.4.0',
      to: '0.5.0',
    });
  });

  test('pinned mode: same version skips even when the registry moved on', () => {
    expect(planAutoUpdate(defaults({ target: '0.4.0', latest: '0.9.0' }))).toEqual({
      action: 'skip',
      reason: 'up-to-date',
    });
  });

  test('pinned mode: a different version installs the pin, downgrades included', () => {
    expect(planAutoUpdate(defaults({ target: '0.3.0', latest: '0.9.0' }))).toEqual({
      action: 'install',
      spec: '@trans-ai/trans-code@0.3.0',
      from: '0.4.0',
      to: '0.3.0',
    });
  });
});
