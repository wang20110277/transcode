import path from 'node:path';

/** One step of the model-maintained task list (todo_write tool). */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A background shell task started via bash run_in_background. */
export interface BackgroundTask {
  id: string;
  pid: number;
  logPath: string;
  command: string;
  startedAt: number;
}

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
  /** Directories whose context note read_file already injected this session. */
  injectedSubdirs: Set<string>;
  /** Current task list, owned by the todo_write tool. */
  todos: TodoItem[];
  /** Background shell tasks (bash run_in_background), keyed by id. */
  bgTasks: Map<string, BackgroundTask>;
}

export function createToolSession(rootCwd: string): ToolSession {
  const absolute = path.resolve(rootCwd);
  return {
    cwd: absolute,
    rootCwd: absolute,
    readFileState: new Set<string>(),
    injectedSubdirs: new Set<string>(),
    todos: [],
    bgTasks: new Map(),
  };
}

export function markFileRead(session: ToolSession, absolutePath: string): void {
  session.readFileState.add(path.resolve(absolutePath));
}

export function hasFileBeenRead(session: ToolSession, absolutePath: string): boolean {
  return session.readFileState.has(path.resolve(absolutePath));
}
