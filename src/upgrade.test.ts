import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  autoUpdateNotice,
  isDevInstall,
  planAutoUpdate,
  startAutoUpdate,
} from './upgrade.js';

let configDir: string | undefined;

function useTempConfig(raw: unknown): void {
  configDir = mkdtempSync(path.join(tmpdir(), 'transcode-autoupdate-test-'));
  process.env.TRANSCODE_CONFIG_PATH = path.join(configDir, 'config.json');
  writeFileSync(process.env.TRANSCODE_CONFIG_PATH, JSON.stringify({ autoUpdate: raw }));
}

afterEach(() => {
  delete process.env.TRANSCODE_CONFIG_PATH;
  if (configDir) {
    rmSync(configDir, { recursive: true, force: true });
    configDir = undefined;
  }
});

describe('isDevInstall', () => {
  test('an entry under the npm root is a global install', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'transcode-root-test-'));
    try {
      mkdirSync(path.join(root, '@trans-ai'));
      const entry = path.join(root, '@trans-ai', 'trans-code.ts');
      writeFileSync(entry, '');
      expect(isDevInstall(entry, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an entry outside the npm root (repo checkout / bun link) is a dev install', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'transcode-root-test-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'transcode-dev-test-'));
    try {
      const entry = path.join(outside, 'trans-code.ts');
      writeFileSync(entry, '');
      expect(isDevInstall(entry, root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('autoUpdateNotice / startAutoUpdate', () => {
  test('autoUpdateNotice resolves null before startAutoUpdate runs', async () => {
    expect(await autoUpdateNotice()).toBeNull();
  });

  test('a disabled config settles the notice to null without touching npm', async () => {
    useTempConfig(false);
    startAutoUpdate();
    expect(await autoUpdateNotice()).toBeNull();
    // lastCheck must not be written for a disabled updater.
    const saved = JSON.parse(
      await Bun.file(process.env.TRANSCODE_CONFIG_PATH!).text(),
    );
    expect(saved.autoUpdate).toBe(false);
  });
});

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

describe('background update silence (spawned-runner E2E)', () => {
  /**
   * Spawns a runner that calls startAutoUpdate() against a fake npm whose
   * non-`root` calls fail on stderr after a 5s sleep (degraded network).
   * `holdMs` keeps the runner alive that long, simulating a REPL session.
   * Returns the child's exit status and captured stderr.
   */
  async function runAgainstSlowFailingNpm(holdMs: number) {
    const dir = mkdtempSync(path.join(tmpdir(), 'transcode-silence-test-'));
    try {
      const bin = path.join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, 'npm'),
        [
          '#!/bin/sh',
          // A root that contains every path lets the dev-install guard pass.
          'if [ "$1" = "root" ]; then echo "/"; exit 0; fi',
          'sleep 5',
          'echo "npm error fake-network-boom" >&2',
          'exit 1',
        ].join('\n'),
      );
      const { chmodSync } = await import('node:fs');
      chmodSync(path.join(bin, 'npm'), 0o755);

      const configPath = path.join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ autoUpdate: { lastCheck: 0 } }));

      const runner = path.join(dir, 'runner.ts');
      writeFileSync(
        runner,
        `import { startAutoUpdate } from ${JSON.stringify(path.join(import.meta.dir, 'upgrade.ts'))};\n` +
          'startAutoUpdate();\n' +
          `setTimeout(() => {}, ${holdMs});\n`,
      );

      const { spawnSync } = await import('node:child_process');
      // Strip bun-test-injected vars: a child `bun <file>` with BUN_TEST_*
      // set misbehaves. Keep the ambient PATH/HOME only.
      const cleanEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith('BUN_')) cleanEnv[key] = value;
      }
      const result = spawnSync(process.execPath, [runner], {
        timeout: 9000,
        encoding: 'utf8',
        env: {
          ...cleanEnv,
          PATH: `${bin}:${process.env.PATH}`,
          TRANSCODE_CONFIG_PATH: configPath,
        },
      });
      return {
        status: result.status,
        signal: result.signal,
        stderr: result.stderr ?? '',
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test(
    'quitting right after startup must not hang on a slow npm',
    async () => {
      const { status, signal, stderr } = await runAgainstSlowFailingNpm(0);
      expect(
        `status=${status} signal=${signal}\n${stderr.slice(0, 300)}`,
      ).toBe('status=0 signal=null\n');
    },
    15_000,
  );

  test(
    'npm failure text must never reach the terminal (silent failure)',
    async () => {
      // Stay alive past the fake npm's 5s sleep so the failure would land
      // if stderr were inherited.
      const { status, stderr } = await runAgainstSlowFailingNpm(6500);
      expect(status).toBe(0);
      expect(stderr).not.toContain('fake-network-boom');
    },
    15_000,
  );
});
