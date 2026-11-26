import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  autoUpdateNotice,
  isDevInstall,
  npmCommandLine,
  npmSpawnSpec,
  planAutoUpdate,
  startAutoUpdate,
  startNpm,
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

describe('npmSpawnSpec', () => {
  test('windows npm must go through npm.cmd with a shell', () => {
    // npm is a batch file on Windows and Node refuses to spawn .cmd
    // without a shell (CVE-2024-27980) — plain spawn('npm') is ENOENT.
    expect(npmSpawnSpec('win32')).toEqual({ command: 'npm.cmd', shell: true });
  });

  test('unix npm spawns directly, no shell wrapper', () => {
    expect(npmSpawnSpec('darwin')).toEqual({ command: 'npm', shell: false });
    expect(npmSpawnSpec('linux')).toEqual({ command: 'npm', shell: false });
  });
});

describe('npm through a shell', () => {
  test('the shell gets one command line, built from the arguments', () => {
    expect(
      npmCommandLine('npm.cmd', ['view', '@trans-ai/trans-code@latest', 'version', '--registry=https://registry.npmjs.org']),
    ).toBe('npm.cmd view @trans-ai/trans-code@latest version --registry=https://registry.npmjs.org');
  });

  test('nothing is started when an argument is not a bare word', () => {
    expect(startNpm(['i', '-g', '@trans-ai/trans-code@1.0.0 & calc'], ['ignore', 'pipe', 'pipe'], {
      command: 'npm.cmd',
      shell: true,
    })).toBeNull();
  });

  test('an argument the shell could take apart is refused, never escaped', () => {
    // Versions, tags, flags and URLs are bare words; everything here would
    // let the shell split, expand or chain the line.
    const hostile = [
      '1.0.0 & calc', '1.0.0 | more', '1.0.0; x', '1.0.0 beta', '1.0.0\tnext', '"1.0.0"', "1.0.0'",
      '$HOME', '`x`', '(x)', '^1.0.0', '%PATH%', 'a>b', 'a<b', 'a\nb', 'a\\b', '--flag=a b',
    ];
    for (const arg of hostile) {
      expect(npmCommandLine('npm.cmd', ['i', '-g', `@trans-ai/trans-code@${arg}`])).toBeNull();
    }
    // An empty argument is no word either. (Appended to the package name it
    // would read as a valid bare word, so it gets its own check.)
    expect(npmCommandLine('npm.cmd', ['i', '-g', ''])).toBeNull();
  });

  test('every argument npm is run with is a bare word, so the checks above refuse nothing in practice', () => {
    const registry = '--registry=https://registry.npmjs.org';
    for (const args of [
      ['root', '-g'],
      ['view', '@trans-ai/trans-code@latest', 'version', registry],
      ['i', '-g', '@trans-ai/trans-code@latest', registry],
      ['i', '-g', '@trans-ai/trans-code@0.12.13', registry],
      ['i', '-g', '@trans-ai/trans-code@1.0.0-beta.1', registry],
    ]) {
      expect(npmCommandLine('npm.cmd', args)).not.toBeNull();
    }
  });

  test(
    'running npm through a shell raises no deprecation on Node',
    async () => {
      // The warning is Node's (DEP0190: an args array with shell: true), and
      // the shipped CLI runs on Node — so build for Node and run it there,
      // on the path Windows takes but with the unix npm.
      const dir = mkdtempSync(path.join(tmpdir(), 'transcode-dep0190-test-'));
      try {
        const outfile = path.join(dir, 'upgrade.mjs');
        const built = await Bun.build({
          entrypoints: [path.join(import.meta.dir, 'upgrade.ts')],
          target: 'node',
          packages: 'external',
        });
        expect(built.success).toBe(true);
        expect(built.outputs).toHaveLength(1);
        // This Bun keeps the artifact in memory: write it out for Node to import.
        writeFileSync(outfile, await built.outputs[0]!.text());

        const runner = path.join(dir, 'runner.mjs');
        writeFileSync(
          runner,
          [
            `import { startNpm } from ${JSON.stringify(outfile)};`,
            "const child = startNpm(['--version'], ['ignore', 'pipe', 'pipe'], { command: 'npm', shell: true });",
            "if (!child) { console.error('REFUSED'); process.exit(3); }",
            "let out = '';",
            "child.stdout.on('data', (d) => { out += d; });",
            "child.on('error', (e) => { console.error(String(e)); process.exit(2); });",
            "child.on('close', (code) => { process.stdout.write(out); process.exit(code ?? 1); });",
            '',
          ].join('\n'),
        );

        const { spawnSync } = await import('node:child_process');
        // Strip bun-test-injected vars: a child `node <file>` need not see them.
        const cleanEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined && !key.startsWith('BUN_')) cleanEnv[key] = value;
        }
        const result = spawnSync('node', [runner], { timeout: 20_000, encoding: 'utf8', env: cleanEnv });
        if (result.error) throw new Error(`node could not be started: ${result.error.message}`);

        expect(result.stderr).not.toContain('DEP0190');
        expect(`status=${result.status}\n${result.stderr.slice(0, 300)}`).toBe('status=0\n');
        expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
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
