import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool } from './types.js';
import type { ToolSession } from './session.js';
import { isReadOnlyCommand } from './read-only.js';
import { fromPosixPath, toPosixPath } from './shell-paths.js';

const MAX_BASH_OUTPUT = 30_000;
const TRUNCATE_HEAD = 15_000;
const TRUNCATE_TAIL = 10_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;

let cwdFileCounter = 0;

/** Single-quote a value for safe inclusion in a shell command line. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Git Bash probe locations for Windows (Claude Code's list). */
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`,
].filter((candidate) => candidate.length > 0);

/** PowerShell probe locations (pwsh 7 preferred over Windows PowerShell 5). */
const POWERSHELL_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\PowerShell\\7\\pwsh.exe`,
];

/** Pure, testable shell resolution: override → SHELL → Git Bash → PowerShell → /bin/bash. */
export function detectShellWith(
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
  env: { TRANSCODE_SHELL?: string; SHELL?: string },
): string {
  const override = env.TRANSCODE_SHELL?.trim();
  if (override) return override;

  const envShell = env.SHELL?.trim() ?? '';
  if (envShell.includes('bash') || envShell.includes('zsh')) return envShell;

  if (platform === 'win32') {
    const gitBash = GIT_BASH_CANDIDATES.find((candidate) => exists(candidate));
    if (gitBash) return gitBash;
    const pwsh = POWERSHELL_CANDIDATES.find((candidate) => exists(candidate));
    if (pwsh) return pwsh;
    // powershell.exe ships with every Windows and resolves via PATH.
    return 'powershell.exe';
  }
  return '/bin/bash';
}

function detectShell(): string {
  return detectShellWith(process.platform, existsSync, process.env);
}

function isZsh(shell: string): boolean {
  return shell.includes('zsh');
}

export function isPowerShell(shell: string): boolean {
  return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell.trim());
}

/** PowerShell single-quoting: only ' needs doubling. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rcFileFor(shell: string): string {
  // $HOME first (POSIX convention, also overridable in tests), os.homedir()
  // as the Windows fallback (USERPROFILE), tmpdir as the last resort.
  const home = process.env.HOME?.trim() || homedir() || tmpdir();
  return isZsh(shell) ? path.join(home, '.zshrc') : path.join(home, '.bashrc');
}

/**
 * Builds the script that captures the user's interactive shell state
 * (functions, shell options, aliases) into a re-sourceable snapshot file.
 * Ported from Claude Code's ShellSnapshot.getUserSnapshotContent.
 */
function snapshotScript(shell: string, snapshotPath: string, rcFile: string, rcExists: boolean): string {
  const zsh = isZsh(shell);
  const userContent = rcExists
    ? zsh
      ? `
        echo "# Functions" >> "$SNAPSHOT_FILE"
        typeset -f > /dev/null 2>&1
        typeset +f | grep -vE '^_[^_]' | while read func; do
          typeset -f "$func" >> "$SNAPSHOT_FILE"
        done
        echo "# Shell Options" >> "$SNAPSHOT_FILE"
        setopt | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"
      `
      : `
        echo "# Functions" >> "$SNAPSHOT_FILE"
        declare -f > /dev/null 2>&1
        declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do
          declare -f "$func" >> "$SNAPSHOT_FILE"
        done
        echo "# Shell Options" >> "$SNAPSHOT_FILE"
        shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"
        set -o | grep "on" | awk '{print "set -o " $1}' | head -n 1000 >> "$SNAPSHOT_FILE"
        echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
      `
    : zsh
      ? ''
      : 'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"';

  return `SNAPSHOT_FILE=${shellQuote(toPosixPath(snapshotPath))}
    ${rcExists ? `source ${shellQuote(toPosixPath(rcFile))} < /dev/null` : '# No user config file to source'}

    echo "# Snapshot file" >| "$SNAPSHOT_FILE"

    # Unset aliases so function definitions do not capture stale ones
    echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"

    ${userContent}

    echo "# Aliases" >> "$SNAPSHOT_FILE"
    alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"

    if [ ! -f "$SNAPSHOT_FILE" ]; then
      echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2
      exit 1
    fi`;
}

/**
 * Creates the shell environment snapshot once per session by loading the
 * user's shell configuration. Returns the snapshot path, or undefined when
 * creation fails (callers then fall back to a login shell per command).
 */
async function createSnapshot(shell: string): Promise<string | undefined> {
  const snapshotsDir = path.join(tmpdir(), 'transcode-shell-snapshots');
  const snapshotPath = path.join(
    snapshotsDir,
    `snapshot-${process.pid}-${Date.now().toString(36)}.sh`,
  );

  let rcExists = false;
  const rcFile = rcFileFor(shell);
  try {
    await fs.access(rcFile);
    rcExists = true;
  } catch {
    rcExists = false;
  }

  try {
    await fs.mkdir(snapshotsDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        shell,
        ['-l', '-c', snapshotScript(shell, snapshotPath, rcFile, rcExists)],
        {
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, SHELL: shell, GIT_EDITOR: 'true', TRANSCODE: '1' },
        },
      );
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Snapshot creation timed out'));
      }, SNAPSHOT_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Snapshot shell exited with code ${code}`));
      });
    });
    const stat = await fs.stat(snapshotPath);
    if (stat.size === 0) return undefined;
    return snapshotPath;
  } catch {
    return undefined;
  }
}

function getSnapshot(session: ToolSession, shell: string): Promise<string | undefined> {
  if (!session.shellSnapshot) {
    session.shellSnapshot = createSnapshot(shell).catch(() => undefined);
  }
  return session.shellSnapshot;
}

/** Keeps the head and the tail of oversized output so failures stay visible. */
function truncateMiddle(text: string): string {
  if (text.length <= MAX_BASH_OUTPUT) return text;
  const omitted = text.length - TRUNCATE_HEAD - TRUNCATE_TAIL;
  return `${text.slice(0, TRUNCATE_HEAD)}\n... [${omitted} bytes truncated] ...\n${text.slice(-TRUNCATE_TAIL)}`;
}

/**
 * Resolves the directory to spawn in, recovering to the workspace root when
 * the persisted cwd no longer exists (e.g. deleted by a previous command).
 */
async function resolveSpawnCwd(session: ToolSession): Promise<string> {
  try {
    await fs.realpath(session.cwd);
    return session.cwd;
  } catch {
    try {
      await fs.realpath(session.rootCwd);
      session.cwd = session.rootCwd;
      return session.rootCwd;
    } catch {
      throw new Error(
        `Working directory "${session.cwd}" no longer exists. Restart transcode from an existing directory.`,
      );
    }
  }
}

/**
 * Wraps the user command so the snapshot is sourced, extended globs are
 * disabled (security), and the physical cwd is captured even when the
 * command fails. PowerShell runs an analogous wrapper: Invoke-Expression
 * instead of eval, Out-File instead of pwd -P >|, no snapshot (NoProfile).
 */
export function buildWrappedCommand(
  command: string,
  shell: string,
  snapshotPath: string | undefined,
  cwdFilePath: string,
): string {
  if (isPowerShell(shell)) {
    return [
      `Invoke-Expression ${psQuote(command)}`,
      '$__transcode_rc = if ($?) { 0 } else { 1 }',
      `try { (Get-Location).ProviderPath | Out-File -FilePath ${psQuote(cwdFilePath)} -Encoding ascii } catch {}`,
      'exit $__transcode_rc',
    ].join('\n');
  }

  const parts: string[] = [];
  if (snapshotPath) {
    parts.push(`source ${shellQuote(toPosixPath(snapshotPath))} 2>/dev/null || true`);
  }
  parts.push(
    isZsh(shell)
      ? 'setopt NO_EXTENDED_GLOB 2>/dev/null || true'
      : 'shopt -u extglob 2>/dev/null || true',
  );
  parts.push(`eval ${shellQuote(command)}`);
  parts.push('__transcode_rc=$?');
  parts.push(`pwd -P >| ${shellQuote(toPosixPath(cwdFilePath))}`);
  parts.push('exit $__transcode_rc');
  return parts.join('\n');
}

/** Windows kills the tree via taskkill; POSIX uses the process-group kill. */
export function killTreeCommand(
  pid: number,
  platform: NodeJS.Platform,
): { file: string; args: string[] } | null {
  if (platform !== 'win32') return null;
  return { file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
}

/** Spawn argv for the configured shell (testable). */
export function shellSpawnArgs(
  shell: string,
  snapshotPath: string | undefined,
  wrapped: string,
): string[] {
  if (isPowerShell(shell)) {
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapped];
  }
  return snapshotPath ? ['-c', wrapped] : ['-l', '-c', wrapped];
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  const tree = killTreeCommand(pid, process.platform);
  if (tree) {
    spawn(tree.file, tree.args, { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Process (group) already gone.
  }
}

export const bashTool: AgentTool = {
  name: 'bash',
  description:
    'Run a shell command in the workspace using the user shell. The working directory persists ' +
    'between calls. Returns stdout, stderr and the exit code.\n' +
    'IMPORTANT: Avoid using this tool for `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk` or ' +
    '`echo` unless explicitly instructed or you have verified a dedicated tool cannot do it:\n' +
    '- Find files: Use glob (NOT find or ls)\n' +
    '- Search content: Use the grep tool (NOT bash grep/rg)\n' +
    '- Read files: Use read_file (NOT cat/head/tail); it caps lines and paginates with offset/limit\n' +
    '- Edit files: Use edit_file (NOT sed/awk)\n' +
    '- Write files: Use write_file (NOT echo > or cat <<EOF)\n' +
    'Dedicated tools are capped, paginated and easier to review.\n' +
    '- Never repeat an identical command; if the result was not useful, refine it or switch tools.\n' +
    '- Independent commands: make separate bash calls in one message instead of one long && chain.\n' +
    '- Prefer absolute paths over cd; keep one working directory per task.',
  kind: 'execute',
  isMutating: true,
  isReadOnly: (input) => isReadOnlyCommand(String(input.command ?? '')),
  schema: z.object({
    command: z.string().describe('Shell command to run'),
    timeout_ms: z.number().int().min(1000).max(600_000).nullable().optional().describe('Timeout in ms'),
    description: z.string().nullable().optional().describe('Short description of what the command does'),
  }),
  title: (input) => {
    const command = String(input.command ?? '');
    return `terminal: ${command.length > 80 ? `${command.slice(0, 80)}...` : command}`;
  },
  async execute(input, ctx) {
    const command = String(input.command);
    const timeoutMs = Number(input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    if (ctx.signal?.aborted) return 'Command cancelled before it started.';

    const session = ctx.session;
    const shell = detectShell();
    const snapshotPath = isPowerShell(shell)
      ? undefined
      : await getSnapshot(session, shell);
    const cwd = await resolveSpawnCwd(session);
    const cwdFilePath = path.join(
      tmpdir(),
      `transcode-${process.pid}-${cwdFileCounter++}-cwd`,
    );
    const wrapped = buildWrappedCommand(command, shell, snapshotPath, cwdFilePath);

    return await new Promise<string>((resolve) => {
      const child = spawn(shell, shellSpawnArgs(shell, snapshotPath, wrapped), {
        cwd,
        env: { ...process.env, SHELL: shell, GIT_EDITOR: 'true', TRANSCODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let killedForTimeout = false;

      const killTimer = setTimeout(() => {
        killedForTimeout = true;
        killProcessGroup(child.pid, 'SIGTERM');
        setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), 2000).unref();
      }, timeoutMs);

      const onAbort = () => {
        killProcessGroup(child.pid, 'SIGTERM');
        setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), 2000).unref();
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_BASH_OUTPUT * 3) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_BASH_OUTPUT * 3) stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        clearTimeout(killTimer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve(`Failed to start command: ${error.message}`);
      });

      child.on('close', (code, signal) => {
        clearTimeout(killTimer);
        ctx.signal?.removeEventListener('abort', onAbort);

        // Sync read so callers awaiting execute() see the updated cwd immediately.
        try {
          const newCwd = fromPosixPath(readFileSync(cwdFilePath, 'utf8').trim());
          if (newCwd) session.cwd = newCwd;
        } catch {
          // Command exited before pwd ran (e.g. `exit`); keep the previous cwd.
        }
        try {
          unlinkSync(cwdFilePath);
        } catch {
          // Best effort cleanup only.
        }

        const parts: string[] = [];
        if (stdout.trim()) parts.push(truncateMiddle(stdout.trimEnd()));
        if (stderr.trim()) parts.push(`[stderr]\n${truncateMiddle(stderr.trimEnd())}`);
        parts.push(
          killedForTimeout
            ? `[exit] timed out after ${timeoutMs}ms`
            : `[exit] code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`,
        );
        resolve(parts.join('\n\n'));
      });
    });
  },
};
