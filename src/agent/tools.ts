import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tool as langChainTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  kind: ToolKind;
  isMutating: boolean;
  title(input: Record<string, unknown>): string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface InvokeResult {
  ok: boolean;
  output: string;
}

const MAX_READ_BYTES = 100_000;
const MAX_BASH_OUTPUT = 30_000;
const MAX_GREP_MATCHES = 200;
const MAX_GLOB_FILES = 200;

const SKIP_DIRS = new Set([
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated, ${text.length - max} chars omitted)`;
}

function resolveInsideWorkspace(cwd: string, inputPath: string): string {
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

function displayPath(cwd: string, absolute: string): string {
  const relative = path.relative(cwd, absolute);
  return relative && !relative.startsWith('..') ? relative : absolute;
}

async function walkFiles(root: string, signal?: AbortSignal): Promise<string[]> {
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

function globToRegExp(pattern: string): RegExp {
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

function matchesGlob(pattern: string, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const re = globToRegExp(pattern);
  if (!pattern.includes('/')) {
    return re.test(path.posix.basename(normalized));
  }
  return re.test(normalized);
}

async function readTextIfTextFile(file: string): Promise<string | null> {
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

const readFileTool: AgentTool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Returns line-numbered content. ' +
    'Use offset (1-based line) and limit to read large files in chunks.',
  kind: 'read',
  isMutating: false,
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    offset: z.number().int().min(1).nullable().optional().describe('First line to read (1-based)'),
    limit: z.number().int().min(1).max(5000).nullable().optional().describe('Maximum number of lines'),
  }),
  title: (input) => `read: ${String(input.path ?? '')}`,
  async execute(input, ctx) {
    const absolute = resolveInsideWorkspace(ctx.cwd, String(input.path));
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`Not a file: ${input.path}`);
    if (stat.size > 5_000_000) {
      throw new Error(
        `File is ${stat.size} bytes, which exceeds the 5 MB read limit. ` +
          'Use grep or bash (head/tail) to inspect it.',
      );
    }
    if (stat.size > MAX_READ_BYTES && !input.offset && !input.limit) {
      throw new Error(
        `File is ${stat.size} bytes. Pass offset/limit to read it in chunks.`,
      );
    }

    const content = await fs.readFile(absolute, 'utf8');
    const lines = content.split('\n');
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.min(Number(input.limit ?? 2000), 5000);
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = selected
      .map((line, index) => `${String(offset + index).padStart(6)}\t${line}`)
      .join('\n');

    const more = offset - 1 + selected.length < lines.length;
    return truncate(
      numbered + (more ? `\n... (${lines.length} lines total)` : ''),
      MAX_READ_BYTES,
    );
  },
};

const writeFileTool: AgentTool = {
  name: 'write_file',
  description:
    'Create or overwrite a file in the workspace with the given content. ' +
    'Prefer edit_file for existing files so unrelated content is preserved.',
  kind: 'edit',
  isMutating: true,
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    content: z.string().describe('Full file content to write'),
  }),
  title: (input) => `write: ${String(input.path ?? '')}`,
  async execute(input, ctx) {
    const absolute = resolveInsideWorkspace(ctx.cwd, String(input.path));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, String(input.content), 'utf8');
    return `Wrote ${Buffer.byteLength(String(input.content), 'utf8')} bytes to ${displayPath(
      ctx.cwd,
      absolute,
    )}`;
  },
};

const editFileTool: AgentTool = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing file. The old_string must appear exactly once ' +
    'unless replace_all is true. Read the file first to get exact text.',
  kind: 'edit',
  isMutating: true,
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    old_string: z.string().describe('Exact text to replace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().nullable().optional().describe('Replace every occurrence'),
  }),
  title: (input) => `patch: ${String(input.path ?? '')}`,
  async execute(input, ctx) {
    const absolute = resolveInsideWorkspace(ctx.cwd, String(input.path));
    const oldString = String(input.old_string);
    const newString = String(input.new_string);
    if (oldString === newString) throw new Error('old_string and new_string are identical');

    const original = await fs.readFile(absolute, 'utf8');
    const occurrences = oldString === '' ? 0 : original.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new Error('old_string was not found in the file. Read it again and use exact text.');
    }
    if (occurrences > 1 && input.replace_all !== true) {
      throw new Error(
        `old_string appears ${occurrences} times. Pass replace_all=true or include more context.`,
      );
    }

    const updated =
      input.replace_all === true
        ? original.split(oldString).join(newString)
        : original.replace(oldString, () => newString);
    await fs.writeFile(absolute, updated, 'utf8');

    return `Replaced ${input.replace_all === true ? occurrences : 1} occurrence(s) in ${displayPath(
      ctx.cwd,
      absolute,
    )}`;
  },
};

const globTool: AgentTool = {
  name: 'glob',
  description:
    'Find files by glob pattern (for example "**/*.ts" or "src/**/test*.js"). ' +
    'Returns workspace-relative paths.',
  kind: 'search',
  isMutating: false,
  schema: z.object({
    pattern: z.string().describe('Glob pattern, matched against workspace-relative paths'),
    path: z.string().nullable().optional().describe('Directory to search in (default: workspace root)'),
  }),
  title: (input) => `search: ${String(input.pattern ?? '')}`,
  async execute(input, ctx) {
    const root = resolveInsideWorkspace(ctx.cwd, String(input.path ?? '.'));
    const pattern = String(input.pattern);
    const files = await walkFiles(root, ctx.signal);
    const matches: string[] = [];

    for (const file of files) {
      const relative = path.relative(root, file).replace(/\\/g, '/');
      if (matchesGlob(pattern, relative)) {
        matches.push(displayPath(ctx.cwd, file));
        if (matches.length >= MAX_GLOB_FILES) break;
      }
    }

    matches.sort();
    if (matches.length === 0) return `No files matched ${pattern}`;
    return (
      matches.join('\n') +
      (matches.length >= MAX_GLOB_FILES ? `\n... (limited to ${MAX_GLOB_FILES} files)` : '')
    );
  },
};

const grepTool: AgentTool = {
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns path:line: text matches. ' +
    'Use include to restrict files by glob (for example "**/*.ts").',
  kind: 'search',
  isMutating: false,
  schema: z.object({
    pattern: z.string().describe('JavaScript regular expression to search for'),
    path: z.string().nullable().optional().describe('Directory or file to search (default: workspace root)'),
    include: z.string().nullable().optional().describe('Glob that file paths must match'),
    ignore_case: z.boolean().nullable().optional().describe('Case-insensitive search'),
  }),
  title: (input) => `search: ${String(input.pattern ?? '')}`,
  async execute(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(String(input.pattern), input.ignore_case ? 'i' : '');
    } catch (error) {
      throw new Error(`Invalid regular expression: ${(error as Error).message}`);
    }

    const target = resolveInsideWorkspace(ctx.cwd, String(input.path ?? '.'));
    const stat = await fs.stat(target);
    const files = stat.isFile() ? [target] : await walkFiles(target, ctx.signal);
    const include = input.include ? String(input.include) : undefined;
    const results: string[] = [];

    for (const file of files) {
      if (ctx.signal?.aborted) throw new Error('Aborted');
      const relative = displayPath(ctx.cwd, file);
      if (include && !matchesGlob(include, relative)) continue;

      let content: string | null;
      try {
        content = await readTextIfTextFile(file);
      } catch {
        continue;
      }
      if (content === null) continue;

      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[index])) continue;
        const text = lines[index].length > 500 ? `${lines[index].slice(0, 500)}...` : lines[index];
        results.push(`${relative}:${index + 1}: ${text}`);
        if (results.length >= MAX_GREP_MATCHES) break;
      }
      if (results.length >= MAX_GREP_MATCHES) break;
    }

    if (results.length === 0) return `No matches for ${input.pattern}`;
    return (
      results.join('\n') +
      (results.length >= MAX_GREP_MATCHES ? `\n... (limited to ${MAX_GREP_MATCHES} matches)` : '')
    );
  },
};

const bashTool: AgentTool = {
  name: 'bash',
  description:
    'Run a shell command in the workspace using bash. Returns stdout, stderr and the exit code. ' +
    'Prefer dedicated read/write/edit/glob/grep tools for file operations.',
  kind: 'execute',
  isMutating: true,
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
    const timeoutMs = Number(input.timeout_ms ?? 120_000);
    if (ctx.signal?.aborted) return 'Command cancelled before it started.';

    return await new Promise<string>((resolve) => {
      const child = spawn('bash', ['-lc', command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killedForTimeout = false;

      const killTimer = setTimeout(() => {
        killedForTimeout = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }, timeoutMs);

      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_BASH_OUTPUT * 2) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_BASH_OUTPUT * 2) stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        clearTimeout(killTimer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve(`Failed to start command: ${error.message}`);
      });

      child.on('close', (code, signal) => {
        clearTimeout(killTimer);
        ctx.signal?.removeEventListener('abort', onAbort);

        const parts: string[] = [];
        if (stdout.trim()) parts.push(truncate(stdout.trimEnd(), MAX_BASH_OUTPUT));
        if (stderr.trim()) parts.push(`[stderr]\n${truncate(stderr.trimEnd(), MAX_BASH_OUTPUT)}`);
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

export const AGENT_TOOLS: AgentTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
];

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((item) => item.name === name);
}

/** Tool definitions bound to the model. Execution happens locally via invokeTool. */
export function bindableTools(tools: AgentTool[] = AGENT_TOOLS): StructuredToolInterface[] {
  return tools.map((item) =>
    langChainTool(async () => '', {
      name: item.name,
      description: item.description,
      schema: item.schema,
    }),
  );
}

export async function invokeTool(
  item: AgentTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<InvokeResult> {
  const parsed = item.schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      output: `Invalid input for ${item.name}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  try {
    const output = await item.execute(parsed.data as Record<string, unknown>, ctx);
    return { ok: true, output: output || '(no output)' };
  } catch (error) {
    return { ok: false, output: `Error: ${(error as Error).message}` };
  }
}
