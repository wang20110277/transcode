import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * User-level memory: global instructions (~/.transcode/TRANS.md) plus a
 * directory of one-fact-per-file memories. Directory files are the source
 * of truth; MEMORY.md is a write-through index regenerated on every
 * save/delete, never read back.
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  description: string;
  content: string;
}

export interface UserMemory {
  globalInstructions: string | null;
  entries: MemoryEntry[];
  omitted: string[];
}

export const USER_MEMORY_BUDGET_CHARS = 12_000;

/** Over-budget drop priority: user facts survive longest, pointers go first. */
const PRIORITY: Record<MemoryType, number> = { user: 3, feedback: 2, project: 1, reference: 0 };
const MEMORY_TYPES = Object.keys(PRIORITY) as MemoryType[];
const TRUNCATION_NOTE = '... (global instructions truncated)';
const DESCRIPTION_MAX_CHARS = 60;

// Test isolation mirrors TRANSCODE_SESSIONS_DIR.
export function userMemoryRoot(): string {
  return process.env.TRANSCODE_USER_DIR ?? path.join(homedir(), '.transcode');
}

export function globalInstructionsPath(): string {
  return path.join(userMemoryRoot(), 'TRANS.md');
}

export function memoryDir(): string {
  return path.join(userMemoryRoot(), 'memory');
}

/**
 * Trimmed, separator-free single-token file stem; null when the name
 * cannot be a memory file. Internal whitespace is rejected (frontmatter
 * round-trips stay line-stable and /forget's single-token args reach the
 * file), and the reserved index stem MEMORY is never a memory.
 */
export function sanitizeMemoryName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.toLowerCase() === 'memory') return null;
  return trimmed;
}

/** Line-level frontmatter parse (name/type/description only); null when malformed. */
export function parseMemoryFile(raw: string): MemoryEntry | null {
  const lines = raw.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (start >= lines.length || lines[start].trim() !== '---') return null;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  let name: string | null = null;
  let type: MemoryType | null = null;
  let description = '';
  for (let i = start + 1; i < end; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    const key = lines[i].slice(0, colon).trim();
    const value = lines[i].slice(colon + 1).trim();
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
    else if (key === 'type' && (MEMORY_TYPES as string[]).includes(value)) {
      type = value as MemoryType;
    }
  }
  if (!name || !type) return null;
  return { name, type, description, content: lines.slice(end + 1).join('\n').trim() };
}

export function renderMemoryFile(entry: MemoryEntry): string {
  return (
    `---\nname: ${entry.name}\ntype: ${entry.type}\ndescription: ${entry.description}\n---\n` +
    `${entry.content}\n`
  );
}

export function renderMemoryIndex(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((e) => `- [${e.name}](${e.name}.md) — ${e.description}`).join('\n') + '\n';
}

/** Memory files in display (alphabetical) order; malformed files are skipped. */
function scanEntries(): MemoryEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(memoryDir());
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const file of files.filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').sort()) {
    try {
      const parsed = parseMemoryFile(fs.readFileSync(path.join(memoryDir(), file), 'utf8'));
      if (parsed) entries.push(parsed);
    } catch {
      // Unreadable item (permissions, a directory, …): skip, like malformed files.
    }
  }
  return entries;
}

/** Atomic replace: a crash mid-write can never truncate a memory file. */
function writeAtomic(target: string, data: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the original error matters more.
    }
    throw error;
  }
}

function rewriteIndex(): void {
  writeAtomic(path.join(memoryDir(), 'MEMORY.md'), renderMemoryIndex(scanEntries()));
}

function deriveDescription(content: string): string {
  const first = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return first.length > DESCRIPTION_MAX_CHARS ? first.slice(0, DESCRIPTION_MAX_CHARS) : first;
}

export async function loadUserMemory(): Promise<UserMemory> {
  let globalInstructions: string | null = null;
  let remaining = USER_MEMORY_BUDGET_CHARS;
  try {
    const raw = fs.readFileSync(globalInstructionsPath(), 'utf8').trim();
    if (raw) {
      globalInstructions =
        raw.length > remaining
          ? `${raw.slice(0, Math.max(0, remaining - TRUNCATION_NOTE.length - 1))}\n${TRUNCATION_NOTE}`
          : raw;
      remaining -= globalInstructions.length;
    }
  } catch {
    // No global instructions file yet.
  }

  // Over budget: drop whole entries (never clip mid-fact), lowest priority
  // first, ties resolved to the last in alphabetical display order.
  const kept = scanEntries();
  const omitted: string[] = [];
  const totalCost = () => kept.reduce((sum, e) => sum + renderMemoryFile(e).length, 0);
  while (totalCost() > remaining && kept.length > 0) {
    let victim = 0;
    for (let i = 1; i < kept.length; i++) {
      if (PRIORITY[kept[i].type] <= PRIORITY[kept[victim].type]) victim = i;
    }
    omitted.push(kept[victim].name);
    kept.splice(victim, 1);
  }

  return { globalInstructions, entries: kept, omitted };
}

export async function saveMemory(input: {
  name: string;
  type: MemoryType;
  content: string;
  description?: string;
}): Promise<MemoryEntry> {
  const name = sanitizeMemoryName(input.name);
  if (!name) throw new Error(`invalid memory name: ${JSON.stringify(input.name)}`);
  const entry: MemoryEntry = {
    name,
    type: input.type,
    description: input.description?.trim() || deriveDescription(input.content),
    content: input.content.trim(),
  };
  fs.mkdirSync(memoryDir(), { recursive: true });
  writeAtomic(path.join(memoryDir(), `${name}.md`), renderMemoryFile(entry));
  rewriteIndex();
  return entry;
}

export async function deleteMemory(name: string): Promise<boolean> {
  let safe = sanitizeMemoryName(name);
  if (!safe) {
    // Legacy files created under the lenient sanitize (internal
    // whitespace) still load — they must stay deletable (#10): allow the
    // looser name for lookup only; path separators stay forbidden.
    const loose = name.trim();
    if (!loose || loose === '.' || loose === '..' || loose.includes('/') || loose.includes('\\')) {
      return false;
    }
    safe = loose;
  }
  const target = path.join(memoryDir(), `${safe}.md`);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target);
  rewriteIndex();
  return true;
}
