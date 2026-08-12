import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ANSWER_CONFIG, loadAnswerConfig, parseModelPreference } from './config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-answer-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(agentDir: string, value: unknown): void {
  const dir = join(agentDir, 'configs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'answer.json'), JSON.stringify(value));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseModelPreference', () => {
  it('keeps slashes inside the model id', () => {
    expect(parseModelPreference('fireworks/accounts/fireworks/models/glm-5p2')).toEqual({
      provider: 'fireworks',
      modelId: 'accounts/fireworks/models/glm-5p2',
    });
  });

  it('rejects incomplete model specs', () => {
    expect(parseModelPreference('claude-fable-5')).toBeUndefined();
    expect(parseModelPreference('/claude-fable-5')).toBeUndefined();
    expect(parseModelPreference('anthropic/')).toBeUndefined();
  });
});

describe('loadAnswerConfig', () => {
  it('uses the current preference list when no config exists', () => {
    expect(loadAnswerConfig(tempDir())).toEqual({ config: DEFAULT_ANSWER_CONFIG, warnings: [] });
  });

  it('loads and deduplicates an ordered model preference list', () => {
    const agentDir = tempDir();
    writeConfig(agentDir, {
      extractionModels: ['fireworks/glm-latest', 'anthropic/claude-fable-5', 'fireworks/glm-latest'],
    });

    expect(loadAnswerConfig(agentDir)).toEqual({
      config: { extractionModels: ['fireworks/glm-latest', 'anthropic/claude-fable-5'] },
      warnings: [],
    });
  });

  it('warns and falls back for invalid JSON', () => {
    const agentDir = tempDir();
    const dir = join(agentDir, 'configs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'answer.json'), '{ nope');

    const result = loadAnswerConfig(agentDir);
    expect(result.config).toEqual(DEFAULT_ANSWER_CONFIG);
    expect(result.warnings).toHaveLength(1);
  });

  it('warns and falls back for an empty preference list', () => {
    const agentDir = tempDir();
    writeConfig(agentDir, { extractionModels: [] });

    const result = loadAnswerConfig(agentDir);
    expect(result.config).toEqual(DEFAULT_ANSWER_CONFIG);
    expect(result.warnings[0]).toContain('non-empty array');
  });

  it('warns and falls back for an invalid model spec', () => {
    const agentDir = tempDir();
    writeConfig(agentDir, { extractionModels: ['claude-fable-5'] });

    const result = loadAnswerConfig(agentDir);
    expect(result.config).toEqual(DEFAULT_ANSWER_CONFIG);
    expect(result.warnings[0]).toContain('provider/model-id');
  });
});
