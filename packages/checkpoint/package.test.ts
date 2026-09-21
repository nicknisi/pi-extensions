/**
 * Packaging, manifest, standalone-loading, and release-integration checks.
 *
 * These assert the published shape of the package without a real model: the
 * manifest points `pi.extensions` at source and `exports` at compiled output,
 * the editable dot-directory prompts survive `npm pack`, the extension loads
 * through the actual Pi resource loader (not a mocked factory import), and the
 * repository has the root-README row and a changeset release entry.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')) as {
  name: string;
  files: string[];
  exports: Record<string, { default?: string; types?: string }>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
};

const PROMPT_FILES = [
  'USER_PROMPT_COMPACTION_MESSAGE.md',
  'USER_PROMPT_SOFT_SELF_COMPACT.md',
  'USER_PROMPT_WARNING_SELF_COMPACT.md',
];

describe('manifest', () => {
  it('uses the checkpoint package name', () => {
    expect(pkg.name).toBe('@nicknisi/pi-checkpoint');
  });

  it('registers the extension from source, not from dist', () => {
    const entries = pkg.pi?.extensions ?? [];
    expect(entries).toEqual(['./extensions/self-compact/self-compact.ts']);
    for (const entry of entries) {
      expect(entry.startsWith('./dist/')).toBe(false);
      expect(existsSync(join(HERE, entry))).toBe(true);
    }
  });

  it('publishes the compiled entry through exports.default', () => {
    const main = pkg.exports['.'];
    expect(main?.default).toBe('./dist/index.js');
    expect(main?.types).toBe('./dist/index.d.ts');
  });

  it('declares the minimum supported Pi runtime and pulls in no other extension', () => {
    expect(pkg.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('>=0.86.1');
    expect(pkg.peerDependencies?.['@earendil-works/pi-ai']).toBe('>=0.86.1');
    const deps = { ...pkg.dependencies };
    // No dependency on sibling extensions or the workspace-shared library.
    for (const name of Object.keys(deps)) {
      expect(name.startsWith('@nicknisi/')).toBe(false);
      expect(deps[name]).not.toMatch(/^workspace:/);
    }
  });

  it('lists the source, compiled output, and editable prompts in files', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('extensions');
    expect(pkg.files).toContain('.pi/self-compact');
  });
});

describe('packed contents', () => {
  let packed: string[];

  beforeAll(() => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: HERE, encoding: 'utf8' });
    const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    packed = parsed[0]?.files.map((f) => f.path) ?? [];
  });

  it('includes the extension source and compiled entry', () => {
    expect(packed).toContain('extensions/self-compact/self-compact.ts');
    expect(packed).toContain('dist/index.js');
    expect(packed).toContain('dist/index.d.ts');
  });

  it('includes all three editable dot-directory prompts', () => {
    for (const name of PROMPT_FILES) {
      expect(packed).toContain(`.pi/self-compact/${name}`);
    }
  });

  it('excludes regression tests and fixtures', () => {
    for (const path of packed) {
      expect(path.startsWith('verify/')).toBe(false);
      expect(path.endsWith('.test.ts')).toBe(false);
    }
  });
});

describe('compiled entry', () => {
  it('exposes a default factory function from dist after a package-local build', async () => {
    const distEntry = join(HERE, 'dist', 'index.js');
    expect(existsSync(distEntry)).toBe(true);
    const mod = (await import(distEntry)) as { default?: unknown };
    expect(typeof mod.default).toBe('function');
  });
});

describe('standalone loading through the real Pi resource loader', () => {
  it('loads the manifest extension path with no errors and registers the tool, commands, and flags', async () => {
    const extEntry = pkg.pi?.extensions?.[0];
    expect(extEntry).toBeDefined();
    const absExtension = join(HERE, extEntry as string);

    const agentDir = mkdtempSync(join(tmpdir(), 'self-compact-pkg-'));
    const loader = new DefaultResourceLoader({
      cwd: HERE,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      // Discover nothing; load ONLY this extension by its manifest path, exactly
      // as `pi -ne -e <path>` would. No factory is injected.
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [absExtension],
    });
    await loader.reload();

    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const extension = loaded.extensions.find((e) => e.resolvedPath === absExtension || e.path === absExtension);
    expect(extension).toBeDefined();
    expect(extension?.tools.has('self_compact')).toBe(true);
    expect(extension?.commands.has('self-compact-info')).toBe(true);
    expect(extension?.commands.has('self-compact-now')).toBe(true);
    for (const flag of ['compact-soft-at', 'compact-at', 'compact-buffer', 'compact-prompt']) {
      expect(extension?.flags.has(flag)).toBe(true);
    }
    rmSync(agentDir, { recursive: true, force: true });
  });
});

describe('release integration', () => {
  it('has a root README table row linking to this package', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/\[checkpoint\]\(packages\/checkpoint\/?\)/);
  });

  it('has a package README documenting requirements and flags', () => {
    const readme = readFileSync(join(HERE, 'README.md'), 'utf8');
    expect(readme).toContain('self_compact');
    expect(readme).toContain('--compact-at');
    expect(readme).toMatch(/0\.86\.1/);
  });

  it('has a changeset (or consumed changelog) release entry for this package', () => {
    const changesetDir = join(REPO_ROOT, '.changeset');
    const entries = existsSync(changesetDir)
      ? readdirSync(changesetDir).filter((f) => f.endsWith('.md') && f !== 'README.md')
      : [];
    const hasChangeset = entries.some((f) => readFileSync(join(changesetDir, f), 'utf8').includes(pkg.name));
    // After Changesets consumes the entry on release, a CHANGELOG.md remains as
    // the durable record — accept either so the test survives a real release.
    const hasChangelog = existsSync(join(HERE, 'CHANGELOG.md'));
    expect(hasChangeset || hasChangelog).toBe(true);
  });
});
