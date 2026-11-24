/**
 * Runtime-switchable permission mode, shared by the REPL and the ACP server.
 * Initialized from TRANSCODE_PERMISSION_MODE; switchable at runtime via /mode.
 *
 * - ask:      mutating tools prompt (read-only bash commands pass silently)
 * - auto:     everything is allowed without prompting
 * - readonly: mutating tools are denied; read-only commands still run
 */
export type PermissionMode = 'ask' | 'auto' | 'readonly';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'readonly'];

function parseMode(value: string | undefined): PermissionMode {
  const lower = value?.toLowerCase();
  return PERMISSION_MODES.includes(lower as PermissionMode) ? (lower as PermissionMode) : 'ask';
}

let currentMode: PermissionMode = parseMode(process.env.TRANSCODE_PERMISSION_MODE);

type PermissionModeListener = (mode: PermissionMode) => void;
const listeners = new Set<PermissionModeListener>();

/** Notified on every mode change (the REPL's mode indicator subscribes). Returns an unsubscribe fn. */
export function subscribePermissionMode(listener: PermissionModeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function applyMode(mode: PermissionMode): void {
  currentMode = mode;
  for (const listener of listeners) listener(mode);
}

export function getPermissionMode(): PermissionMode {
  return currentMode;
}

/** Shift+Tab cycling order: ask → auto → readonly → ask. */
export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const index = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length]!;
}

export function setPermissionMode(mode: PermissionMode): void {
  if (!PERMISSION_MODES.includes(mode)) {
    throw new Error(`Unknown permission mode: ${mode}. Valid: ${PERMISSION_MODES.join(', ')}`);
  }
  applyMode(mode);
}

/** Re-reads the environment variable (used at startup and in tests). */
export function resetPermissionMode(): void {
  applyMode(parseMode(process.env.TRANSCODE_PERMISSION_MODE));
}
