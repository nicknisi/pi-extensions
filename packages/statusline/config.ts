import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface StatuslineConfig {
  /** Extension status keys (the first argument to ctx.ui.setStatus) to omit. */
  hiddenStatuses: string[];
}

export interface LoadedStatuslineConfig {
  config: StatuslineConfig;
  warnings: string[];
}

export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = {
  hiddenStatuses: [],
};

export function statuslineConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'configs', 'statusline.json');
}

export function loadStatuslineConfig(agentDir = getAgentDir()): LoadedStatuslineConfig {
  const path = statuslineConfigPath(agentDir);
  if (!existsSync(path)) {
    return { config: { ...DEFAULT_STATUSLINE_CONFIG }, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      config: { ...DEFAULT_STATUSLINE_CONFIG },
      warnings: [`Invalid statusline config at ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      config: { ...DEFAULT_STATUSLINE_CONFIG },
      warnings: [`Invalid statusline config at ${path}: expected an object`],
    };
  }

  const hiddenStatuses = (parsed as Record<string, unknown>).hiddenStatuses;
  if (hiddenStatuses === undefined) {
    return { config: { ...DEFAULT_STATUSLINE_CONFIG }, warnings: [] };
  }
  if (!Array.isArray(hiddenStatuses) || hiddenStatuses.some((key) => typeof key !== 'string')) {
    return {
      config: { ...DEFAULT_STATUSLINE_CONFIG },
      warnings: [`Invalid statusline config at ${path}: hiddenStatuses must be an array of strings`],
    };
  }

  return {
    config: { hiddenStatuses: [...new Set(hiddenStatuses)] },
    warnings: [],
  };
}

export function shouldShowStatus(key: string, config: StatuslineConfig): boolean {
  return !config.hiddenStatuses.includes(key);
}
