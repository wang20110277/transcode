import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MAX_READ_BYTES = 100_000;
export const MAX_GREP_MATCHES = 200;
export const MAX_GLOB_FILES = 200;
export const MAX_LINE_LENGTH = 2_000;

export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.turbo',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
]);

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated, ${text.length - max} chars omitted)`;
}

export function resolveInsideWorkspace(cwd: string, inputPath: string): string {
  const absolute = path.resolve(cwd, inputPath || '.');
  if (process.env.TRANSCODE_ALLOW_OUTSIDE_CWD === '1') return absolute;

  const relative = path.relative(cwd, absolute);
  const inside =
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  if (!inside) {
    throw new Error(
      `Path escapes the workspace: ${inputPath}. ` +
        `Set TRANSCODE_ALLOW_OUTSIDE_CWD=1 to allow it.`,
    );
  }
  return absolute;
}

export function displayPath(cwd: string, absolute: string): string {
  const relative = path.relative(cwd, absolute);
  return relative && !relative.startsWith('..') ? relative : absolute;
}

export async function walkFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    if (signal?.aborted) throw new Error('Aborted');
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  return files;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  p = escapeRegex(p);
  // `**/` should also match zero directories.
  p = p.replace(/\*\*\//g, '\u0001');
  p = p.replace(/\*\*/g, '\u0002');
  p = p.replace(/\*/g, '[^/]*');
  p = p.replace(/\?/g, '[^/]');
  p = p.replace(/\u0001/g, '(?:.*/)?');
  p = p.replace(/\u0002/g, '.*');
  return new RegExp(`^${p}$`);
}

export function matchesGlob(pattern: string, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const re = globToRegExp(pattern);
  if (!pattern.includes('/')) {
    return re.test(path.posix.basename(normalized));
  }
  return re.test(normalized);
}

export async function readTextIfTextFile(file: string): Promise<string | null> {
  const stat = await fs.stat(file);
  if (stat.size > 2_000_000) return null;

  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return null;
    return await fs.readFile(file, 'utf8');
  } finally {
    await handle.close();
  }
}
