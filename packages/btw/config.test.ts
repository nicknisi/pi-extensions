import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BTW_CONFIG, loadBtwConfig, parseModelSpec } from './config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-btw-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(agentDir: string, value: unknown): void {
  const dir = join(agentDir, 'configs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'btw.json'), JSON.stringify(value));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseModelSpec', () => {
  it('keeps slashes inside the model id', () => {
    expect(parseModelSpec('fireworks/accounts/fireworks/models/glm-5p2')).toEqual({
      provider: 'fireworks',
      id: 'accounts/fireworks/models/glm-5p2',
    });
  });

  it('rejects incomplete model specs', () => {
    expect(parseModelSpec('glm-latest')).toBeUndefined();
    expect(parseModelSpec('/glm-latest')).toBeUndefined();
    expect(parseModelSpec('fireworks/')).toBeUndefined();
  });
});

describe('loadBtwConfig', () => {
  it('uses the default when no config exists', () => {
    expect(loadBtwConfig(tempDir())).toEqual({ config: DEFAULT_BTW_CONFIG, warnings: [] });
  });

  it('uses the current model when the config omits model', () => {
    const agentDir = tempDir();
    writeConfig(agentDir, {});
    expect(loadBtwConfig(agentDir)).toEqual({ config: DEFAULT_BTW_CONFIG, warnings: [] });
  });

  it('loads a configured provider and model', () => {
    const agentDir = tempDir();
    writeConfig(agentDir, { model: 'anthropic/claude-sonnet-4-5' });
    expect(loadBtwConfig(agentDir)).toEqual({
      config: { model: 'anthropic/claude-sonnet-4-5' },
      warnings: [],
    });
  });

  it('warns and falls back for invalid JSON', () => {
    const agentDir = tempDir();
    const dir = join(agentDir, 'configs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'btw.json'), '{ nope');

    const result = loadBtwConfig(agentDir);
    expect(result.config).toEqual(DEFAULT_BTW_CONFIG);
    expect(result.warnings).toHaveLength(1);
  });

  it('warns and falls back for an invalid model spec', () => {
    const agentDir = tempDir();
    writeConfig(agentDir, { model: 'glm-latest' });

    const result = loadBtwConfig(agentDir);
    expect(result.config).toEqual(DEFAULT_BTW_CONFIG);
    expect(result.warnings[0]).toContain('provider/model-id');
  });
});
