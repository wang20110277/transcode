import path from 'node:path';

/**
 * State that persists across tool calls within one conversation/session:
 * the shell's current working directory (so `cd` survives between bash
 * calls), the lazily-created login-shell environment snapshot, and the set
 * of files the model has read this session (read-before-edit/write guard).
 */
export interface ToolSession {
  /** Live working directory; updated by the bash tool after every command. */
  cwd: string;
  /** Workspace root the session started in; cwd-recovery fallback. */
  rootCwd: string;
  /** Lazily-created shell environment snapshot file path (bash/zsh script). */
  shellSnapshot?: Promise<string | undefined>;
  /** Absolute paths of files the model has read (or written) this session. */
  readFileState: Set<string>;
}

export function createToolSession(rootCwd: string): ToolSession {
  const absolute = path.resolve(rootCwd);
  return {
    cwd: absolute,
    rootCwd: absolute,
    readFileState: new Set<string>(),
  };
}

export function markFileRead(session: ToolSession, absolutePath: string): void {
  session.readFileState.add(path.resolve(absolutePath));
}

export function hasFileBeenRead(session: ToolSession, absolutePath: string): boolean {
  return session.readFileState.has(path.resolve(absolutePath));
}
