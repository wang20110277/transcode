/**
 * Pure helpers for the REPL @-mention file completion. Rendering/keys live in
 * REPL.tsx; these are the testable parts.
 */

/** Returns the active @query at the end of the input, or null when inactive. */
export function mentionQuery(input: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(input);
  return match === null ? null : match[1];
}

function isSubsequence(query: string, target: string): boolean {
  let pos = -1;
  for (const char of query) {
    pos = target.indexOf(char, pos + 1);
    if (pos === -1) return false;
  }
  return true;
}

/**
 * Filters file paths by query: case-insensitive substring matches first
 * (path order), then subsequence matches. Empty query returns the first
 * `limit` paths unchanged.
 */
export function filterFiles(files: string[], query: string, limit: number): string[] {
  if (query === '') return files.slice(0, limit);
  const lower = query.toLowerCase();
  const substring: string[] = [];
  const subsequence: string[] = [];
  for (const file of files) {
    const fileLower = file.toLowerCase();
    if (fileLower.includes(lower)) {
      substring.push(file);
    } else if (isSubsequence(lower, fileLower)) {
      subsequence.push(file);
    }
    if (substring.length >= limit) break;
  }
  return [...substring, ...subsequence].slice(0, limit);
}

/** Replaces the trailing @token with the selected path (plus a space). */
export function applyCompletion(input: string, selectedPath: string): string {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(input);
  if (match === null) return input;
  const atStart = match.index + (match[0].startsWith('@') ? 0 : 1);
  return `${input.slice(0, atStart)}@${selectedPath} `;
}
