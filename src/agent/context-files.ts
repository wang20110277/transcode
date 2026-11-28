/**
 * Hierarchical project context files (roadmap 阶段一 #3).
 *
 * Discovery walks up from the workspace directory — one context file per
 * level, nearest level wins the budget first, git repository root is the
 * boundary (no git: at most 5 levels). Results are ordered root → nearest
 * so the prompt reads general-to-specific. `@path` imports and the
 * read_file sub-directory lazy notes build on the same name priority.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Per-level priority order (spec: 沿用现有文件名优先级,每级只取一个). */
export const CONTEXT_FILE_NAMES = [
  'TRANS.md',
  'AGENTS.md',
  'CLAUDE.md',
  'TRANSCODE.md',
  '.transcode/AGENTS.md',
];

/** Lazy sub-directory notes skip the repo-level .transcode override. */
const SUBDIR_CONTEXT_FILE_NAMES = CONTEXT_FILE_NAMES.filter(
  (name) => name !== '.transcode/AGENTS.md',
);

export interface ContextFile {
  /** Display path relative to the workspace cwd ('../AGENTS.md' allowed). */
  path: string;
  content: string;
}

export const MAX_CONTEXT_CHARS = 40_000;
const TRUNCATION_MARKER = '... (project instructions truncated)';
const MAX_LEVELS_WITHOUT_GIT = 5;

/** Git repository root of `cwd`, or null when cwd is not inside one. */
export async function gitRootOf(cwd: string): Promise<string | null> {
  try {
    return await new Promise<string | null>((resolve) => {
      execFile('git', ['rev-parse', '--show-toplevel'], { cwd }, (error, stdout) => {
        resolve(error || !stdout.trim() ? null : stdout.trim());
      });
    });
  } catch {
    return null;
  }
}

/**
 * Ancestor chain of `cwd`, nearest → root, both ends included, deduped.
 * `gitRoot` bounds the walk; without it at most MAX_LEVELS_WITHOUT_GIT
 * levels (cwd included) are returned, stopping at the filesystem root.
 * A gitRoot that does not contain cwd is ignored (falls back to the cap).
 */
export async function contextAncestors(cwd: string, gitRoot: string | null): Promise<string[]> {
  const start = path.resolve(cwd);
  let bound = gitRoot ? path.resolve(gitRoot) : null;
  if (bound && bound !== start && !start.startsWith(bound + path.sep)) bound = null;

  const levels: string[] = [];
  let current: string | undefined = start;
  while (current) {
    levels.push(current);
    if (current === bound) break;
    if (!bound && levels.length >= MAX_LEVELS_WITHOUT_GIT) break;
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  return [...new Set(levels)];
}

async function readOptional(file: string): Promise<string | null> {
  try {
    const content = await fs.readFile(file, 'utf8');
    const trimmed = content.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

const MAX_IMPORT_DEPTH = 3;
const MAX_IMPORT_CHARS = 64 * 1024;

/**
 * Whole-line `@相对路径` imports, resolved relative to the importing file's
 * directory. Depth is capped at MAX_IMPORT_DEPTH, each imported file at
 * MAX_IMPORT_CHARS (truncation annotated); missing paths, directories and
 * import cycles degrade to an inline annotation instead of an error.
 * Prose mentions of @something mid-line are left untouched.
 */
export async function resolveContextImports(
  content: string,
  baseDir: string,
  depth = 0,
  seen: Set<string> = new Set(),
): Promise<string> {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^@(\S+)$/.exec(line.trim());
    if (!match) {
      out.push(line);
      continue;
    }
    const spec = match[1]!;
    if (depth + 1 > MAX_IMPORT_DEPTH) {
      out.push(`(@${spec} 超过导入深度上限)`);
      continue;
    }
    const absolute = path.resolve(baseDir, spec);
    if (seen.has(absolute)) {
      out.push(`(@${spec} 循环导入,已跳过)`);
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(absolute, 'utf8');
    } catch {
      out.push(`(@${spec} 导入失败:文件不存在)`);
      continue;
    }
    seen.add(absolute);
    const body =
      raw.length > MAX_IMPORT_CHARS
        ? `${raw.slice(0, MAX_IMPORT_CHARS)}\n... (@${spec} 超过 64KB,已截断)`
        : raw;
    out.push(await resolveContextImports(body, path.dirname(absolute), depth + 1, seen));
  }
  return out.join('\n');
}

/** First context-file hit in `dir` by CONTEXT_FILE_NAMES priority. */
async function pickLevelFile(dir: string): Promise<{ absolute: string; content: string } | null> {
  for (const name of CONTEXT_FILE_NAMES) {
    const absolute = path.join(dir, name);
    const content = await readOptional(absolute);
    if (content) return { absolute, content };
  }
  return null;
}

/**
 * Context files for the hierarchy above `cwd`, ordered root → nearest.
 * The budget (default MAX_CONTEXT_CHARS) is allocated nearest-first, so
 * the closest instructions survive truncation. `@path` imports are
 * resolved per file before budgeting (added alongside resolveContextImports).
 */
export async function loadHierarchyContext(
  cwd: string,
  opts?: { gitRoot?: string | null; budget?: number },
): Promise<ContextFile[]> {
  const budget = opts?.budget ?? MAX_CONTEXT_CHARS;
  const gitRoot =
    opts?.gitRoot !== undefined ? opts.gitRoot : await gitRootOf(cwd);

  const picked: ContextFile[] = [];
  let remaining = budget;
  for (const dir of await contextAncestors(cwd, gitRoot)) {
    if (remaining <= 0) break;
    const found = await pickLevelFile(dir);
    if (!found) continue;
    // Imports resolve before budgeting; the seed makes self-imports cycle.
    const expanded = await resolveContextImports(
      found.content,
      dir,
      0,
      new Set([found.absolute]),
    );
    const clipped =
      expanded.length > remaining
        ? `${expanded.slice(0, remaining)}\n${TRUNCATION_MARKER}`
        : expanded;
    picked.push({ path: path.relative(cwd, found.absolute), content: clipped });
    remaining -= clipped.length;
  }
  return picked.reverse();
}

/** Directories whose context note read_file already injected this session. */
const injectedSubdirs = new Set<string>();

/** Test isolation: clears the per-session sub-directory injection ledger. */
export function resetSubdirInjection(): void {
  injectedSubdirs.clear();
}

/**
 * Context note for a sub-directory the agent just read a file from.
 * Returns null when dir is the workspace cwd itself (its level already
 * lives in the system prompt), when the note was already injected this
 * session, or when the directory has no context file. A miss does not
 * burn the one-shot: a note created later in the session still loads.
 * `@` imports inside the note resolve like any context file.
 */
export async function findSubdirContext(dir: string, cwd: string): Promise<ContextFile | null> {
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(cwd)) return null;
  if (injectedSubdirs.has(resolved)) return null;

  for (const name of SUBDIR_CONTEXT_FILE_NAMES) {
    const absolute = path.join(resolved, name);
    const content = await readOptional(absolute);
    if (content) {
      injectedSubdirs.add(resolved);
      const expanded = await resolveContextImports(content, resolved, 0, new Set([absolute]));
      return { path: path.relative(cwd, absolute), content: expanded };
    }
  }
  return null;
}
