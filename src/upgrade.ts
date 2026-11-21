import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

const PKG = '@trans-ai/trans-code';
// Upgrades must talk to the official registry: mirrors (npmmirror & co)
// sync metadata and tarballs independently, so a just-released version
// can be visible to `view` but not installable, silently "upgrading"
// to the stale version.
const OFFICIAL = 'https://registry.npmjs.org';

const DEFAULT_INTERVAL_HOURS = 24;

export type AutoUpdatePlan =
  | { action: 'skip'; reason: 'env-skip' | 'disabled' | 'throttled' | 'up-to-date' | 'unknown-latest' }
  | { action: 'install'; spec: string; from: string; to: string };

/**
 * Pure decision for the background auto-update: whether to skip (and why)
 * or which package spec to install. Order matters — envSkip and the
 * enabled flag short-circuit before the throttle check so a disabled
 * updater never hits the registry.
 */
export function planAutoUpdate(input: {
  current: string;
  /** Latest version from the registry; null when it could not be reached. */
  latest: string | null;
  /** 'latest' or a pinned version string. */
  target: string;
  enabled: boolean;
  lastCheck: number;
  now: number;
  intervalHours?: number;
  envSkip?: boolean;
}): AutoUpdatePlan {
  if (input.envSkip) return { action: 'skip', reason: 'env-skip' };
  if (!input.enabled) return { action: 'skip', reason: 'disabled' };
  const interval =
    (input.intervalHours ?? DEFAULT_INTERVAL_HOURS) * 3_600_000;
  if (input.now - input.lastCheck < interval) {
    return { action: 'skip', reason: 'throttled' };
  }
  if (input.target === 'latest') {
    if (input.latest === null) return { action: 'skip', reason: 'unknown-latest' };
    if (input.latest === input.current) return { action: 'skip', reason: 'up-to-date' };
    return { action: 'install', spec: `${PKG}@latest`, from: input.current, to: input.latest };
  }
  // Pinned target: stay at it exactly, downgrades included.
  if (input.target === input.current) return { action: 'skip', reason: 'up-to-date' };
  return { action: 'install', spec: `${PKG}@${input.target}`, from: input.current, to: input.target };
}

function sh(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', err => {
      process.stderr.write(`[transcode] failed to run ${cmd}: ${err.message}\n`);
      resolve({ code: 1, stdout });
    });
    child.on('close', code => resolve({ code: code ?? 1, stdout }));
  });
}

function shInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', err => {
      process.stderr.write(`[transcode] failed to run ${cmd}: ${err.message}\n`);
      resolve(1);
    });
    child.on('close', code => resolve(code ?? 1));
  });
}

async function npmRoot(): Promise<string> {
  const r = await sh('npm', ['root', '-g']);
  return r.stdout.trim();
}

async function latestVersion(): Promise<string | null> {
  const r = await sh('npm', ['view', `${PKG}@latest`, 'version', `--registry=${OFFICIAL}`]);
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}

function installedVersionUnder(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(`${root}/${PKG}/package.json`, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export async function runUpgrade(): Promise<void> {
  process.stdout.write(`transcode v${VERSION} — checking for upgrades…\n`);

  const entry = realpathSync(fileURLToPath(import.meta.url));
  const root = await npmRoot();
  // Normalize both sides through realpath — macOS aliases like /tmp vs
  // /private/tmp would otherwise break prefix comparison.
  const rootReal = root ? realpathSync(root) : '';
  if (process.env.TRANSCODE_DEBUG_UPGRADE === '1') {
    process.stdout.write(`[debug] entry=${entry}\n[debug] root=${rootReal}\n`);
  }

  if (!rootReal || !entry.startsWith(rootReal)) {
    process.stdout.write(
      [
        'This looks like a development install (bun link / repo checkout),',
        'not an npm global install — nothing to auto-upgrade.',
        '',
        'Options:',
        '  · pull the latest repo:   git pull && bun install',
        '  · switch to npm install:  npm i -g @trans-ai/trans-code',
      ].join('\n') + '\n',
    );
    return;
  }

  const latest = await latestVersion();
  if (!latest) {
    process.stderr.write(
      '[transcode] could not reach the npm registry to check the latest version.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (latest === VERSION) {
    process.stdout.write(`Already up to date (v${VERSION}).\n`);
    return;
  }

  process.stdout.write(`Upgrading ${VERSION} → ${latest}…\n`);
  const code = await shInherit('npm', ['i', '-g', `${PKG}@latest`, `--registry=${OFFICIAL}`]);
  if (code !== 0) {
    process.stderr.write('[transcode] upgrade failed — see npm output above.\n');
    process.exitCode = 1;
    return;
  }

  const installed = installedVersionUnder(root);
  if (installed) {
    process.stdout.write(`Upgraded to v${installed}. Restart transcode if it is running.\n`);
  } else {
    process.stdout.write(`Upgrade finished. Restart transcode if it is running.\n`);
  }
}
