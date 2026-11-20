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
