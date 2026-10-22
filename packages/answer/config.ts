import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CLASSIFIERS } from '@nicknisi/pi-shared';

export interface AnswerConfig {
  /** Ordered provider/model-id candidates; the first available authenticated model wins. */
  extractionModels: string[];
  /** Classifiers (provider/model-id) that decide when to show the answer hint; the first available wins. Empty turns the hint off. */
  hintModels: string[];
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
  // Pulling questions out of one message is easy: fast, cheap models first.
  extractionModels: ['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5'],
  hintModels: [...DEFAULT_CLASSIFIERS],
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

  const o = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const config: AnswerConfig = { ...DEFAULT_ANSWER_CONFIG };
  const warnings: string[] = [];
  const specs = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((model) => typeof model === 'string' && !!parseModelPreference(model));
  const dedupe = (models: string[]) => [...new Set(models.map((model) => model.trim()))];

  if (o.extractionModels !== undefined) {
    if (specs(o.extractionModels) && o.extractionModels.length > 0)
      config.extractionModels = dedupe(o.extractionModels);
    else
      warnings.push(
        `Invalid answer config at ${path}: extractionModels must be a non-empty array of provider/model-id strings`,
      );
  }
  if (o.hintModels !== undefined) {
    if (specs(o.hintModels)) config.hintModels = dedupe(o.hintModels);
    else warnings.push(`Invalid answer config at ${path}: hintModels must be an array of provider/model-id strings`);
  }

  return { config, warnings };
}
