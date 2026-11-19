import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TranscodeConfig {
  model?: string;
  apiKeys?: Record<string, string>;
}

const CONFIG_PATH = join(homedir(), '.transcode.json');

export function loadConfig(): TranscodeConfig {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed as TranscodeConfig;
  } catch {
    // missing or invalid — treat as empty
  }
  return {};
}

export function saveConfig(config: TranscodeConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
