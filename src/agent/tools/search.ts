import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool } from './types.js';
import {
  MAX_GLOB_FILES,
  MAX_GREP_MATCHES,
  displayPath,
  matchesGlob,
  readTextIfTextFile,
  resolveInsideWorkspace,
  walkFiles,
} from './fs-utils.js';

export const globTool: AgentTool = {
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

export const grepTool: AgentTool = {
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
