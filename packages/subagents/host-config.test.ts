import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_CONFIG_FILE, readHostConfigFile, resolveChildExtensionPaths, resolveTaskCwd } from './host-config.js';
import { applyProfile, parseAgentProfile, type ProfileTaskFields } from './profiles.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-config-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('resolveTaskCwd', () => {
  it('returns the session cwd when the task sets none', () => {
    const root = tempDir();
    expect(resolveTaskCwd(root, undefined)).toEqual({ ok: true, cwd: root });
    expect(resolveTaskCwd(root, '  ')).toEqual({ ok: true, cwd: root });
  });

  it('resolves a nested directory inside the session cwd', () => {
    const root = tempDir();
    mkdirSync(join(root, 'repos', 'acme__widgets'), { recursive: true });
    const result = resolveTaskCwd(root, 'repos/acme__widgets');
    expect(result).toEqual({ ok: true, cwd: join(root, 'repos', 'acme__widgets') });
  });

  it('refuses absolute paths', () => {
    const root = tempDir();
    const result = resolveTaskCwd(root, root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must be relative/);
  });

  it('refuses paths that climb out of the session cwd', () => {
    const root = tempDir();
    const result = resolveTaskCwd(root, '../elsewhere');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not exist|escapes/);
  });

  it('refuses a directory that does not exist', () => {
    const root = tempDir();
    const result = resolveTaskCwd(root, 'repos/missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not exist/);
  });

  it('refuses a symlink that points outside the session cwd', () => {
    const root = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(root, 'escape'));
    const result = resolveTaskCwd(root, 'escape');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/escapes/);
  });
});

describe('readHostConfigFile', () => {
  it('treats a missing file as an empty config', () => {
    const agentDir = tempDir();
    expect(readHostConfigFile(agentDir)).toEqual({ config: {}, warnings: [] });
  });

  it('reads childExtensionPaths', () => {
    const agentDir = tempDir();
    writeFileSync(join(agentDir, HOST_CONFIG_FILE), JSON.stringify({ childExtensionPaths: ['/app/broker.ts'] }));
    expect(readHostConfigFile(agentDir)).toEqual({ config: { childExtensionPaths: ['/app/broker.ts'] }, warnings: [] });
  });

  it('warns and ignores invalid JSON', () => {
    const agentDir = tempDir();
    writeFileSync(join(agentDir, HOST_CONFIG_FILE), '{ not json');
    const result = readHostConfigFile(agentDir);
    expect(result.config).toEqual({});
    expect(result.warnings[0]).toMatch(/invalid JSON/);
  });

  it('warns when childExtensionPaths is not an array of strings', () => {
    const agentDir = tempDir();
    writeFileSync(join(agentDir, HOST_CONFIG_FILE), JSON.stringify({ childExtensionPaths: 'broker.ts' }));
    const result = readHostConfigFile(agentDir);
    expect(result.config).toEqual({});
    expect(result.warnings[0]).toMatch(/must be an array of strings/);
  });

  it('keeps the string entries and warns about the rest', () => {
    const agentDir = tempDir();
    writeFileSync(join(agentDir, HOST_CONFIG_FILE), JSON.stringify({ childExtensionPaths: ['a.ts', 42, ''] }));
    const result = readHostConfigFile(agentDir);
    expect(result.config).toEqual({ childExtensionPaths: ['a.ts'] });
    expect(result.warnings).toHaveLength(1);
  });
});

describe('resolveChildExtensionPaths', () => {
  it('resolves relative entries against the agent dir, dedupes, and separates missing files', () => {
    const agentDir = tempDir();
    mkdirSync(join(agentDir, 'ext'));
    writeFileSync(join(agentDir, 'ext', 'broker.ts'), 'export default () => {};');
    const absolute = join(agentDir, 'ext', 'broker.ts');
    const result = resolveChildExtensionPaths(agentDir, ['ext/broker.ts', absolute], ['ext/missing.ts']);
    expect(result.paths).toEqual([absolute]);
    expect(result.missing).toEqual([join(agentDir, 'ext', 'missing.ts')]);
  });

  it('keeps factory-option order ahead of the config file', () => {
    const agentDir = tempDir();
    writeFileSync(join(agentDir, 'a.ts'), '');
    writeFileSync(join(agentDir, 'b.ts'), '');
    const result = resolveChildExtensionPaths(agentDir, ['b.ts'], ['a.ts', 'b.ts']);
    expect(result.paths).toEqual([join(agentDir, 'b.ts'), join(agentDir, 'a.ts')]);
  });

  it('returns nothing when no source is given', () => {
    expect(resolveChildExtensionPaths(tempDir(), undefined, undefined)).toEqual({ paths: [], missing: [] });
  });
});

describe('profile cwd', () => {
  type Spec = ProfileTaskFields & { task: string };

  it('parses a cwd frontmatter field', () => {
    const parsed = parseAgentProfile(
      ['---', 'description: Builder', 'cwd: repos/acme__widgets', 'worktree: true', '---', 'Build it.'].join('\n'),
      '/profiles/builder.md',
      'user',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.profile.cwd).toBe('repos/acme__widgets');
  });

  it('applies the profile cwd only when the task sets none', () => {
    const profile = {
      name: 'builder',
      description: 'Builder',
      skills: [],
      prompt: '',
      path: '/profiles/builder.md',
      scope: 'user' as const,
      cwd: 'repos/acme__widgets',
    };
    const defaulted = applyProfile<Spec>({ task: 'x' }, profile, []);
    expect(defaulted.cwd).toBe('repos/acme__widgets');
    const explicit = applyProfile<Spec>({ task: 'x', cwd: 'repos/other' }, profile, []);
    expect(explicit.cwd).toBe('repos/other');
  });
});
