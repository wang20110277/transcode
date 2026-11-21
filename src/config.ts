import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A named model endpoint: model id → {address, model name, credential}. */
export interface ProfileConfig {
  baseUrl: string;
  model: string;
  /** Key store id this profile uses (e.g. "glm" for both zhipu endpoints). */
  keyId?: string;
  /** Fallback environment variable for the credential. */
  envKey?: string;
}

export interface TranscodeConfig {
  model?: string;
  apiKeys?: Record<string, string>;
  /** Custom OpenAI-compatible gateway chosen in the /models flow. */
  custom?: { baseUrl: string; model: string };
  /** User-defined model profiles; override built-in registry ids by name. */
  profiles?: Record<string, ProfileConfig>;
  /** Role → profile routing (default / analysis / design / vision / …). */
  routing?: Record<string, string>;
  /** Auto-update on startup: `false` disables, an object configures it. */
  autoUpdate?: boolean | AutoUpdateConfig;
}

/** Raw (on-disk) shape of the autoUpdate config block. */
export interface AutoUpdateConfig {
  enabled?: boolean;
  /** Registry version to stay at; defaults to 'latest'. */
  target?: string;
  /** Epoch ms of the last registry check; internal throttle cache. */
  lastCheck?: number;
}

/** Normalized form used by the updater. */
export interface NormalizedAutoUpdate {
  enabled: boolean;
  target: string;
  lastCheck: number;
}

const DEFAULT_AUTO_UPDATE: NormalizedAutoUpdate = {
  enabled: true,
  target: 'latest',
  lastCheck: 0,
};

/**
 * Normalizes the raw autoUpdate config value. Anything unrecognizable
 * (wrong type, null, arrays) falls back to the enabled default rather
 * than throwing — a bad config must never break startup.
 */
export function normalizeAutoUpdate(raw: unknown): NormalizedAutoUpdate {
  if (raw === false) return { ...DEFAULT_AUTO_UPDATE, enabled: false };
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AUTO_UPDATE };
  }
  const obj = raw as AutoUpdateConfig;
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
    target: typeof obj.target === 'string' && obj.target ? obj.target : 'latest',
    lastCheck: typeof obj.lastCheck === 'number' ? obj.lastCheck : 0,
  };
}

// Overridable so tests never touch the user's real ~/.transcode.json.
const configPath = (): string =>
  process.env.TRANSCODE_CONFIG_PATH ?? join(homedir(), '.transcode.json');

export function loadConfig(): TranscodeConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed as TranscodeConfig;
  } catch {
    // missing or invalid — treat as empty
  }
  return {};
}

export function saveConfig(config: TranscodeConfig): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n');
}
