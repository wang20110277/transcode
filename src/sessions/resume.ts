import { listSessions, type SessionRecord } from './store.js';

/** Sessions whose recorded cwd matches, newest first (project-scoped picker source). */
export function listProjectSessions(cwd: string): SessionRecord[] {
  return listSessions().filter((session) => session.cwd === cwd);
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
