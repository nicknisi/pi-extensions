import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FAST_CONFIG, loadFastConfig } from './config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-fast-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadFastConfig', () => {
  it('uses defaults when no config exists', () => {
    const root = tempDir();
    expect(loadFastConfig(root, true, join(root, 'agent'))).toEqual({
      config: DEFAULT_FAST_CONFIG,
      warnings: [],
    });
  });

  it('merges a nearest trusted project config over global config', () => {
    const root = tempDir();
    const agentDir = join(root, 'agent');
    const project = join(root, 'project');
    const nested = join(project, 'packages', 'app');

    writeJson(join(agentDir, 'configs', 'fast.json'), { enabled: true, showStatus: false });
    writeJson(join(project, '.pi', 'configs', 'fast.json'), { showStatus: true });
    mkdirSync(nested, { recursive: true });

    expect(loadFastConfig(nested, true, agentDir)).toEqual({
      config: { enabled: true, showStatus: true },
      warnings: [],
    });
  });

  it('ignores project config when the project is not trusted', () => {
    const root = tempDir();
    const agentDir = join(root, 'agent');
    const project = join(root, 'project');

    writeJson(join(agentDir, 'configs', 'fast.json'), { enabled: false });
    writeJson(join(project, '.pi', 'configs', 'fast.json'), { enabled: true });

    expect(loadFastConfig(project, false, agentDir).config.enabled).toBe(false);
  });

  it('warns and falls back per invalid file', () => {
    const root = tempDir();
    const agentDir = join(root, 'agent');
    const path = join(agentDir, 'configs', 'fast.json');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{ nope');

    const result = loadFastConfig(root, false, agentDir);
    expect(result.config).toEqual(DEFAULT_FAST_CONFIG);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(path);
  });

  it('ignores invalid fields while keeping valid ones', () => {
    const root = tempDir();
    const agentDir = join(root, 'agent');
    const path = join(agentDir, 'configs', 'fast.json');
    writeJson(path, { enabled: true, showStatus: 'yes' });

    const result = loadFastConfig(root, false, agentDir);
    expect(result.config).toEqual({ enabled: true, showStatus: true });
    expect(result.warnings[0]).toContain('showStatus must be boolean');
  });
});
