import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeAutoUpdate, saveConfig } from './config.js';
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

/**
 * True when the running entry file lives outside the npm global root
 * (repo checkout, bun link) — nothing to auto-upgrade there. Both sides
 * are realpath-normalized so macOS aliases (/tmp vs /private/tmp) and
 * symlinked roots compare correctly.
 */
export function isDevInstall(entryPath: string, npmRoot: string): boolean {
  if (!npmRoot) return true;
  try {
    const entryReal = realpathSync(entryPath);
    const rootReal = realpathSync(npmRoot);
    return !entryReal.startsWith(rootReal);
  } catch {
    return true;
  }
}

/** Like sh(), but fully silent — background installs must not spew into the TUI. */
function shQuiet(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', () => resolve({ code: 1, stdout }));
    child.on('close', code => resolve({ code: code ?? 1, stdout }));
  });
}

let noticePromise: Promise<string | null> = Promise.resolve(null);

/** The auto-update outcome, once settled; null when nothing happened. */
export function autoUpdateNotice(): Promise<string | null> {
  return noticePromise;
}

/**
 * Kick off the background auto-update (REPL startup only). Never throws
 * and never blocks: every failure path settles the notice to null, and
 * npm output stays invisible unless TRANSCODE_DEBUG_UPGRADE=1.
 *
 * lastCheck is written only when the check reached a definitive state
 * (up-to-date, or install succeeded) — on failure the next startup retries.
 */
export function startAutoUpdate(): void {
  noticePromise = (async (): Promise<string | null> => {
    const debug = process.env.TRANSCODE_DEBUG_UPGRADE === '1';
    try {
      const auto = normalizeAutoUpdate(loadConfig().autoUpdate);
      const envSkip = process.env.TRANSCODE_SKIP_UPDATE === '1';
      const intervalHours = Number(process.env.TRANSCODE_UPDATE_INTERVAL_HOURS) || undefined;

      // Cheap gates first — no subprocess before we know we might install.
      const early = planAutoUpdate({
        current: VERSION,
        latest: 'x', // placeholder: gates below never read it
        target: auto.target,
        enabled: auto.enabled,
        lastCheck: auto.lastCheck,
        now: Date.now(),
        intervalHours,
        envSkip,
      });
      if (early.action === 'skip' && early.reason !== 'unknown-latest') {
        if (early.reason === 'up-to-date' && auto.target !== 'latest') return null; // pin satisfied
        return null;
      }

      const root = (await shQuiet('npm', ['root', '-g'])).stdout.trim();
      const entry = realpathSync(fileURLToPath(import.meta.url));
      if (isDevInstall(entry, root)) {
        if (debug) process.stderr.write('[transcode] auto-update: dev install, skipped\n');
        return null;
      }

      const latest = auto.target === 'latest' ? await latestVersion() : auto.target;
      const plan = planAutoUpdate({
        current: VERSION,
        latest,
        target: auto.target,
        enabled: auto.enabled,
        lastCheck: auto.lastCheck,
        now: Date.now(),
        intervalHours,
        envSkip,
      });
      if (plan.action === 'skip') return null;

      const install = await shQuiet('npm', ['i', '-g', plan.spec, `--registry=${OFFICIAL}`]);
      if (install.code !== 0) {
        if (debug) process.stderr.write('[transcode] auto-update install failed\n');
        return null;
      }
      const installed = installedVersionUnder(root);
      writeLastCheck();
      return `⟳ 已自动更新 ${VERSION} → ${installed ?? plan.to}，重启 transcode 生效`;
    } catch (error) {
      if (debug) process.stderr.write(`[transcode] auto-update error: ${String(error)}\n`);
      return null;
    }
  })();
}

function writeLastCheck(): void {
  try {
    const cfg = loadConfig();
    const auto = normalizeAutoUpdate(cfg.autoUpdate);
    cfg.autoUpdate = { ...auto, lastCheck: Date.now() };
    saveConfig(cfg);
  } catch {
    // The throttle cache is best-effort.
  }
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

export async function runUpgrade(target?: string): Promise<void> {
  if (target) {
    process.stdout.write(`transcode v${VERSION} — upgrading to ${target}…\n`);
  } else {
    process.stdout.write(`transcode v${VERSION} — checking for upgrades…\n`);
  }

  const entry = realpathSync(fileURLToPath(import.meta.url));
  const root = await npmRoot();
  if (process.env.TRANSCODE_DEBUG_UPGRADE === '1') {
    process.stdout.write(`[debug] entry=${entry}\n[debug] root=${root}\n`);
  }

  if (isDevInstall(entry, root)) {
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

  if (target) {
    process.stdout.write(`Upgrading ${VERSION} → ${target}…\n`);
    const code = await shInherit('npm', ['i', '-g', `${PKG}@${target}`, `--registry=${OFFICIAL}`]);
    if (code !== 0) {
      process.stderr.write('[transcode] upgrade failed — see npm output above.\n');
      process.exitCode = 1;
      return;
    }
    const installed = installedVersionUnder(root);
    process.stdout.write(`Upgraded to v${installed ?? target}. Restart transcode if it is running.\n`);
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
