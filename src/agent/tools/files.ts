import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool } from './types.js';
import { hasFileBeenRead, markFileRead, type ToolSession } from './session.js';
import { MAX_LINE_LENGTH, MAX_READ_BYTES, displayPath, resolveInsideWorkspace, truncate } from './fs-utils.js';
import { lineDiff } from './diff.js';

const SNIPPET_CONTEXT_LINES = 4;
const NEW_FILE_DIFF_LINES = 20;

// Claude-style quote normalization: models emit straight quotes, files often
// contain curly ones. Both sides are normalized before matching.
const LEFT_SINGLE_CURLY_QUOTE = '‘';
const RIGHT_SINGLE_CURLY_QUOTE = '’';
const LEFT_DOUBLE_CURLY_QUOTE = '“';
const RIGHT_DOUBLE_CURLY_QUOTE = '”';

function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/**
 * Finds the actual string in the file content matching the search string,
 * falling back to quote normalization when the exact match fails.
 * Ported from Claude Code's FileEditTool findActualString.
 */
function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);

  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    return fileContent.substring(searchIndex, searchIndex + searchString.length);
  }

  return null;
}

/** Renders a numbered window around an edit so the model can verify it. */
function snippetAfterEdit(
  original: string,
  oldString: string,
  newString: string,
  startLine: number,
): string {
  const updatedLines = original.split(oldString).join(newString).split(/\r?\n/);
  const lines = updatedLines.slice(startLine, startLine + SNIPPET_CONTEXT_LINES * 2 + Math.max(1, newString.split(/\r?\n/).length) + 2);
  return lines
    .map((line, index) => `${String(startLine + index + 1).padStart(6)}\t${line}`)
    .join('\n');
}

function requireRead(session: ToolSession, absolute: string, display: string): void {
  if (!hasFileBeenRead(session, absolute)) {
    throw new Error(
      `File has not been read this session: ${display}. Read it with read_file first ` +
        'so edits and overwrites are made against known content.',
    );
  }
}

export const readFileTool: AgentTool = {
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
    markFileRead(ctx.session, absolute);

    const lines = content.split('\n');
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.min(Number(input.limit ?? 2000), 5000);
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = selected
      .map((line, index) => {
        const clipped =
          line.length > MAX_LINE_LENGTH
            ? `${line.slice(0, MAX_LINE_LENGTH)}... [line truncated]`
            : line;
        return `${String(offset + index).padStart(6)}\t${clipped}`;
      })
      .join('\n');

    const more = offset - 1 + selected.length < lines.length;
    return truncate(
      numbered + (more ? `\n... (${lines.length} lines total)` : ''),
      MAX_READ_BYTES,
    );
  },
};

export const writeFileTool: AgentTool = {
  name: 'write_file',
  description:
    'Create or overwrite a file in the workspace with the given content. ' +
    'Existing files must be read with read_file first. ' +
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
    let exists = true;
    try {
      await fs.access(absolute);
    } catch {
      exists = false;
    }
    if (exists) {
      requireRead(ctx.session, absolute, displayPath(ctx.cwd, absolute));
    }

    let previous: string | null = null;
    if (exists) {
      previous = await fs.readFile(absolute, 'utf8').catch(() => null);
    }

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const content = String(input.content);
    await fs.writeFile(absolute, content, 'utf8');
    markFileRead(ctx.session, absolute);

    const summary = `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${displayPath(
      ctx.cwd,
      absolute,
    )}`;
    if (previous !== null) {
      return { output: summary, diff: lineDiff(previous, content) || undefined };
    }

    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const shown = lines.slice(0, NEW_FILE_DIFF_LINES);
    const diffParts = shown.map((line) => `+${line}`);
    if (lines.length > NEW_FILE_DIFF_LINES) {
      diffParts.push(`... (+${lines.length - NEW_FILE_DIFF_LINES} more lines)`);
    }
    return {
      output: summary,
      diff: lines.length === 0 ? undefined : `@@ -0,0 +1,${lines.length} @@\n${diffParts.join('\n')}`,
    };
  },
};

export const editFileTool: AgentTool = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing file. The old_string must appear exactly once ' +
    'unless replace_all is true. Read the file first to get exact text. ' +
    'Straight/curly quote differences are normalized automatically.',
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
    requireRead(ctx.session, absolute, displayPath(ctx.cwd, absolute));

    const oldString = String(input.old_string);
    const newString = String(input.new_string);
    if (oldString === newString) throw new Error('old_string and new_string are identical');

    const original = await fs.readFile(absolute, 'utf8');

    const actualOld = findActualString(original, oldString);
    if (actualOld === null) {
      throw new Error('old_string was not found in the file. Read it again and use exact text.');
    }
    const occurrences = actualOld === '' ? 0 : original.split(actualOld).length - 1;
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
        ? original.split(actualOld).join(newString)
        : original.replace(actualOld, () => newString);
    await fs.writeFile(absolute, updated, 'utf8');

    const replacedCount = input.replace_all === true ? occurrences : 1;
    const before = original.split(actualOld)[0] ?? '';
    const replacementLine = before.split(/\r?\n/).length - 1;
    const snippetStart = Math.max(0, replacementLine - SNIPPET_CONTEXT_LINES);
    const snippet = snippetAfterEdit(original, actualOld, newString, snippetStart);

    return {
      output:
        `Replaced ${replacedCount} occurrence(s) in ${displayPath(ctx.cwd, absolute)}\n\n` +
        `${snippet}`,
      diff: lineDiff(original, updated) || undefined,
    };
  },
};
