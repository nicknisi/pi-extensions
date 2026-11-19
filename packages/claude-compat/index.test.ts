import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivePackageRoot, rewriteRootRef } from './index.js';

describe('derivePackageRoot', () => {
  it('returns the directory three levels above SKILL.md', () => {
    expect(derivePackageRoot('/pkg/skills/a/SKILL.md')).toBe('/pkg');
  });
});

describe('rewriteRootRef', () => {
  it('returns text unchanged with no roots', () => {
    expect(rewriteRootRef('cat ${CLAUDE_PLUGIN_ROOT}/a', [])).toBe('cat ${CLAUDE_PLUGIN_ROOT}/a');
  });

  it('rewrites braced, bare, and path forms with a single root', () => {
    expect(rewriteRootRef('cat ${CLAUDE_PLUGIN_ROOT}/a.md', ['/r'])).toBe('cat /r/a.md');
    expect(rewriteRootRef('cat $CLAUDE_PLUGIN_ROOT/a.md', ['/r'])).toBe('cat /r/a.md');
    expect(rewriteRootRef('cd ${CLAUDE_PLUGIN_ROOT}', ['/r'])).toBe('cd /r');
  });

  it('picks the root where the file exists among multiple roots', () => {
    const a = mkdtempSync(join(tmpdir(), 'ccroot-'));
    const b = mkdtempSync(join(tmpdir(), 'ccroot-'));
    mkdirSync(join(b, 'scripts'));
    writeFileSync(join(b, 'scripts', 'x.sh'), '');
    expect(rewriteRootRef('bash ${CLAUDE_PLUGIN_ROOT}/scripts/x.sh', [a, b])).toBe(`bash ${b}/scripts/x.sh`);
    expect(rewriteRootRef('bash ${CLAUDE_PLUGIN_ROOT}/missing', [a, b])).toBe(`bash ${a}/missing`);
  });

  it('does not merge separate arguments or touch other expansions', () => {
    expect(rewriteRootRef('ls $CLAUDE_PLUGIN_ROOT /etc', ['/r'])).toBe('ls /r /etc');
    expect(rewriteRootRef('echo ${CLAUDE_PLUGIN_ROOT:-x}', ['/r'])).toBe('echo ${CLAUDE_PLUGIN_ROOT:-x}');
    expect(rewriteRootRef('echo $CLAUDE_PLUGIN_ROOTX', ['/r'])).toBe('echo $CLAUDE_PLUGIN_ROOTX');
  });
});
