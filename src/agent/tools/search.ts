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
  workspaceFiles,
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
    const files = await workspaceFiles(root, ctx.signal);
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
    multiline: z.boolean().nullable().optional().describe('Let the pattern match across line breaks'),
    context: z.number().int().min(0).max(10).nullable().optional().describe('Show N context lines around each match'),
  }),
  title: (input) => `search: ${String(input.pattern ?? '')}`,
  async execute(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(
        String(input.pattern),
        `${input.ignore_case ? 'i' : ''}m${input.multiline ? 's' : ''}`,
      );
    } catch (error) {
      throw new Error(`Invalid regular expression: ${(error as Error).message}`);
    }

    const target = resolveInsideWorkspace(ctx.cwd, String(input.path ?? '.'));
    const stat = await fs.stat(target);
    const files = stat.isFile() ? [target] : await workspaceFiles(target, ctx.signal);
    const include = input.include ? String(input.include) : undefined;
    const results: string[] = [];
    const context = Number(input.context ?? 0);

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

      if (input.multiline === true) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          if (match[0] === '') break; // zero-length match guard
          const startLine = content.slice(0, match.index).split('\n').length;
          const endLine = startLine - 1 + match[0].split('\n').length;
          const text = match[0].length > 400 ? `${match[0].slice(0, 400)}...` : match[0];
          results.push(`${relative}:${startLine}-${endLine}: ${text.replace(/\n/g, '\\n')}`);
          if (results.length >= MAX_GREP_MATCHES) break;
        }
        if (results.length >= MAX_GREP_MATCHES) break;
        continue;
      }

      const hits: number[] = [];
      for (let index = 0; index < lines.length; index++) {
        regex.lastIndex = 0;
        if (regex.test(lines[index])) hits.push(index);
      }

      if (context > 0) {
        // rg-style: hits as rel:N:, context as rel-N-, groups split by --.
        const isHit = new Set(hits);
        const shown = new Set<number>();
        for (const hit of hits) {
          for (let n = hit - context; n <= hit + context; n++) {
            if (n >= 0 && n < lines.length) shown.add(n);
          }
        }
        let previous = -2;
        for (const index of [...shown].sort((a, b) => a - b)) {
          if (previous >= 0 && index - previous > 1) results.push('--');
          previous = index;
          const raw = lines[index];
          const text = raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
          results.push(
            isHit.has(index) ? `${relative}:${index + 1}: ${text}` : `${relative}-${index + 1}- ${text}`,
          );
          if (results.length >= MAX_GREP_MATCHES) break;
        }
      } else {
        for (const hit of hits) {
          const raw = lines[hit];
          const text = raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
          results.push(`${relative}:${hit + 1}: ${text}`);
        }
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
