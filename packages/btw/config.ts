import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface BtwConfig {
  /** Model as provider/model-id. Model ids may themselves contain slashes. */
  model: string;
}

export interface LoadedBtwConfig {
  config: BtwConfig;
  warnings: string[];
}

export const DEFAULT_BTW_CONFIG: BtwConfig = {
  model: 'fireworks/glm-latest',
};

export function btwConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'configs', 'btw.json');
}

export function parseModelSpec(value: string): { provider: string; id: string } | undefined {
  const spec = value.trim();
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export function loadBtwConfig(agentDir = getAgentDir()): LoadedBtwConfig {
  const path = btwConfigPath(agentDir);
  if (!existsSync(path)) return { config: { ...DEFAULT_BTW_CONFIG }, warnings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      config: { ...DEFAULT_BTW_CONFIG },
      warnings: [`Invalid btw config at ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const model =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).model
      : undefined;
  if (typeof model !== 'string' || !parseModelSpec(model)) {
    return {
      config: { ...DEFAULT_BTW_CONFIG },
      warnings: [`Invalid btw config at ${path}: model must be a provider/model-id string`],
    };
  }

  return { config: { model: model.trim() }, warnings: [] };
}
