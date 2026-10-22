import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface BtwConfig {
  /** Optional model override as provider/model-id. Model ids may themselves contain slashes. */
  model?: string;
  /** Optional thinking level override; when unset, /btw uses the session thinking level. */
  thinking?: ModelThinkingLevel;
}

const THINKING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] satisfies ModelThinkingLevel[];

export interface LoadedBtwConfig {
  config: BtwConfig;
  warnings: string[];
}

export const DEFAULT_BTW_CONFIG: BtwConfig = {};

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

  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const config: BtwConfig = { ...DEFAULT_BTW_CONFIG };
  const warnings: string[] = [];

  const model = record.model;
  if (model !== undefined) {
    if (typeof model !== 'string' || !parseModelSpec(model)) {
      warnings.push(`Invalid btw config at ${path}: model must be a provider/model-id string`);
    } else {
      config.model = model.trim();
    }
  }

  const thinking = record.thinking;
  if (thinking !== undefined) {
    if (typeof thinking !== 'string' || !THINKING_LEVELS.includes(thinking)) {
      warnings.push(`Invalid btw config at ${path}: thinking must be one of ${THINKING_LEVELS.join(', ')}`);
    } else {
      config.thinking = thinking as ModelThinkingLevel;
    }
  }

  return { config, warnings };
}
