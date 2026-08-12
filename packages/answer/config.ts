import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface AnswerConfig {
  /** Ordered provider/model-id candidates; the first available authenticated model wins. */
  extractionModels: string[];
}

export interface LoadedAnswerConfig {
  config: AnswerConfig;
  warnings: string[];
}

export interface ModelPreference {
  provider: string;
  modelId: string;
}

export const DEFAULT_ANSWER_CONFIG: AnswerConfig = {
  extractionModels: ['anthropic/claude-fable-5', 'anthropic/claude-opus-5'],
};

export function answerConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, 'configs', 'answer.json');
}

export function parseModelPreference(value: string): ModelPreference | undefined {
  const spec = value.trim();
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

export function loadAnswerConfig(agentDir = getAgentDir()): LoadedAnswerConfig {
  const path = answerConfigPath(agentDir);
  if (!existsSync(path)) return { config: { ...DEFAULT_ANSWER_CONFIG }, warnings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      config: { ...DEFAULT_ANSWER_CONFIG },
      warnings: [`Invalid answer config at ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const extractionModels =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).extractionModels
      : undefined;
  if (
    !Array.isArray(extractionModels) ||
    extractionModels.length === 0 ||
    extractionModels.some((model) => typeof model !== 'string' || !parseModelPreference(model))
  ) {
    return {
      config: { ...DEFAULT_ANSWER_CONFIG },
      warnings: [
        `Invalid answer config at ${path}: extractionModels must be a non-empty array of provider/model-id strings`,
      ],
    };
  }

  return {
    config: { extractionModels: [...new Set(extractionModels.map((model) => model.trim()))] },
    warnings: [],
  };
}
