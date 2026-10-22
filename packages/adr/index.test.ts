import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAdrDir, listAdrs } from './index.js';

describe('findAdrDir', () => {
  it('finds docs/decisions in an ancestor of cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'adr-'));
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(findAdrDir(nested)).toBe(join(root, 'docs', 'decisions'));
  });

  it('stops at the repo root', () => {
    const outer = mkdtempSync(join(tmpdir(), 'adr-'));
    mkdirSync(join(outer, 'docs', 'decisions'), { recursive: true });
    const repo = join(outer, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(findAdrDir(join(repo))).toBeNull();
  });

  it('returns null when nothing exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'adr-'));
    expect(findAdrDir(root)).toBeNull();
  });
});

describe('listAdrs', () => {
  it('returns numbered files sorted, skipping templates and superseded/', () => {
    const root = mkdtempSync(join(tmpdir(), 'adr-'));
    const dir = join(root, 'docs', 'decisions');
    mkdirSync(join(dir, 'superseded'), { recursive: true });
    writeFileSync(join(dir, '0002-second.md'), '');
    writeFileSync(join(dir, '0001-first.md'), '');
    writeFileSync(join(dir, '0000-template.md'), '');
    writeFileSync(join(dir, '0003-template-rendering.md'), '');
    writeFileSync(join(dir, 'README.md'), '');
    writeFileSync(join(dir, 'superseded', '0009-old.md'), '');
    expect(listAdrs(dir)).toEqual(['0001-first.md', '0002-second.md', '0003-template-rendering.md']);
  });
});

describe('before_agent_start', () => {
  it('sets and clears the decision_records prompt section', async () => {
    const { default: extension } = await import('./index.js');
    let handler!: (event: any, ctx: any) => unknown;
    extension({ on: (_name: string, fn: typeof handler) => (handler = fn) } as never);
    const root = mkdtempSync(join(tmpdir(), 'adr-'));
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    writeFileSync(join(root, 'docs', 'decisions', '0001-first.md'), '');
    const sections: Record<string, string> = {};
    expect(handler({ systemPromptOptions: { sections } }, { cwd: root })).toBeUndefined();
    expect(sections.decision_records).toContain('- docs/decisions/0001-first.md');
    handler({ systemPromptOptions: { sections } }, { cwd: mkdtempSync(join(tmpdir(), 'adr-')) });
    expect(sections.decision_records).toBeUndefined();
  });

  it('lists paths relative to cwd when pi runs in a subdirectory', async () => {
    const { default: extension } = await import('./index.js');
    let handler!: (event: any, ctx: any) => unknown;
    extension({ on: (_name: string, fn: typeof handler) => (handler = fn) } as never);
    const root = mkdtempSync(join(tmpdir(), 'adr-'));
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    writeFileSync(join(root, 'docs', 'decisions', '0001-first.md'), '');
    const nested = join(root, 'packages', 'foo');
    mkdirSync(nested, { recursive: true });
    const sections: Record<string, string> = {};
    handler({ systemPromptOptions: { sections } }, { cwd: nested });
    expect(sections.decision_records).toContain('- ../../docs/decisions/0001-first.md');
  });
});
