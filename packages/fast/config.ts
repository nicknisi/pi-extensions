import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';

export interface FastConfig {
  /** Default Fast mode state when there is no session override. */
  enabled: boolean;
  /** Show a compact `fast` footer status while Fast mode is active. */
  showStatus: boolean;
}

export interface LoadedFastConfig {
  config: FastConfig;
  warnings: string[];
}

export const DEFAULT_FAST_CONFIG: FastConfig = {
  enabled: false,
  showStatus: true,
};

export function globalFastConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'configs', 'fast.json');
}

export function findProjectFastConfigPath(cwd: string): string | undefined {
  let current = cwd;

  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, 'configs', 'fast.json');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readConfigFile(path: string): { config: Partial<FastConfig>; warning?: string } {
  if (!existsSync(path)) return { config: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      config: {},
      warning: `Invalid fast config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: {}, warning: `Invalid fast config at ${path}: expected an object` };
  }

  const value = parsed as Record<string, unknown>;
  const config: Partial<FastConfig> = {};
  const invalid: string[] = [];

  for (const key of ['enabled', 'showStatus'] as const) {
    if (!(key in value)) continue;
    if (typeof value[key] === 'boolean') config[key] = value[key];
    else invalid.push(key);
  }

  return {
    config,
    ...(invalid.length > 0 ? { warning: `Invalid fast config at ${path}: ${invalid.join(', ')} must be boolean` } : {}),
  };
}

function mergeConfig(base: FastConfig, overrides: Partial<FastConfig>): FastConfig {
  return {
    enabled: overrides.enabled ?? base.enabled,
    showStatus: overrides.showStatus ?? base.showStatus,
  };
}

export function loadFastConfig(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): LoadedFastConfig {
  const global = readConfigFile(globalFastConfigPath(agentDir));
  const projectPath = projectTrusted ? findProjectFastConfigPath(cwd) : undefined;
  const project = projectPath ? readConfigFile(projectPath) : { config: {} };

  return {
    config: mergeConfig(mergeConfig(DEFAULT_FAST_CONFIG, global.config), project.config),
    warnings: [global.warning, project.warning].filter((warning): warning is string => warning !== undefined),
  };
}
