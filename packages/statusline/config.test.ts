import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STATUSLINE_CONFIG, loadStatuslineConfig, shouldShowStatus } from './config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-statusline-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(agentDir: string, value: unknown): void {
  const dir = join(agentDir, 'configs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'statusline.json'), JSON.stringify(value));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadStatuslineConfig', () => {
  it('shows every extension status when no config exists', () => {
    expect(loadStatuslineConfig(tempDir())).toEqual({
      config: DEFAULT_STATUSLINE_CONFIG,
      warnings: [],
    });
  });

  it('loads and deduplicates hidden status keys', () => {
    const agentDir = tempDir();
    writeConfig(agentDir, { hiddenStatuses: ['mcp', 'mcp', 'fast'] });

    expect(loadStatuslineConfig(agentDir)).toEqual({
      config: { hiddenStatuses: ['mcp', 'fast'] },
      warnings: [],
    });
  });

  it('warns and falls back when the file is invalid JSON', () => {
    const agentDir = tempDir();
    const dir = join(agentDir, 'configs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'statusline.json'), '{ nope');

    const result = loadStatuslineConfig(agentDir);
    expect(result.config).toEqual(DEFAULT_STATUSLINE_CONFIG);
    expect(result.warnings).toHaveLength(1);
  });

  it('warns and falls back when hiddenStatuses is not a string array', () => {
    const agentDir = tempDir();
    writeConfig(agentDir, { hiddenStatuses: ['mcp', 1] });

    const result = loadStatuslineConfig(agentDir);
    expect(result.config).toEqual(DEFAULT_STATUSLINE_CONFIG);
    expect(result.warnings[0]).toContain('hiddenStatuses must be an array of strings');
  });
});

describe('shouldShowStatus', () => {
  it('hides only configured status keys', () => {
    const config = { hiddenStatuses: ['mcp'] };
    expect(shouldShowStatus('mcp', config)).toBe(false);
    expect(shouldShowStatus('subagents', config)).toBe(true);
  });
});
