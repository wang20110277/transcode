import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listSessions, readSessionRecord, sessionsRoot, projectDirName, type SessionRecord } from './store.js';

/**
 * Sessions of ONE project, newest first — the picker source for /resume and
 * ACP session/list. Reads only that project's directory (#20: the old
 * listSessions()-then-filter parsed every session file in the store), and
 * matches cwd spellings canonically so /tmp vs /private/tmp both hit.
 */
export async function listProjectSessions(cwd: string): Promise<SessionRecord[]> {
  const wanted = await realpathQuiet(cwd);
  const dir = path.join(sessionsRoot(), projectDirName(cwd));
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const file of files) {
    const record = readSessionRecord(path.join(dir, file));
    if (!record) continue;
    // The directory already scopes by cwd spelling; realpath comparing
    // catches alias spellings stored under the same directory name.
    if (record.cwd === cwd || (await realpathQuiet(record.cwd)) === wanted) {
      records.push(record);
    }
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function realpathQuiet(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Split /resume args: the second token is a keep-turns attempt ONLY when it
 * is pure digits; otherwise all tokens join into the target (multi-word
 * title fragments keep working).
 */
export function splitResumeArgs(args: string[]): { target: string; keepRaw?: string } {
  const hasKeepArg = args.length > 1 && /^\d+$/.test(args[1]!);
  return {
    target: (hasKeepArg ? args[0] : args.join(' ')).trim(),
    ...(hasKeepArg ? { keepRaw: args[1] } : {}),
  };
}

/**
 * Resolve a /resume argument to a session record.
 * Blank target → undefined (caller opens the picker). Numeric → the last
 * listed session at that index (falling back to list order). Otherwise
 * exact id first, then id/title substring match. Undefined → not found.
 */
export function resolveResumeTarget(
  target: string,
  lastIds: string[],
  list: SessionRecord[],
): SessionRecord | undefined {
  const query = target.trim();
  if (!query) return undefined;
  if (/^\d+$/.test(query)) {
    const index = Number(query) - 1;
    const viaLast = lastIds[index];
    if (viaLast) {
      const record = list.find((session) => session.id === viaLast);
      if (record) return record;
    }
    return list[index];
  }
  return (
    list.find((session) => session.id === query) ??
    list.find((session) => session.id.includes(query) || session.title.includes(query))
  );
}
