import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import dynamicSkills, {
  HAS_CMD,
  buildSkillPrompt,
  expandCommands,
  normalizeReadPath,
  registeredSkillPaths,
} from './dynamic-skills.js';

describe('placeholder matching', () => {
  it('detects inline and fenced forms but not KEY=!`x`', () => {
    expect(HAS_CMD.test('- diff: !`echo hi`')).toBe(true);
    expect(HAS_CMD.test('```!\necho hi\n```')).toBe(true);
    expect(HAS_CMD.test('KEY=!`echo hi`')).toBe(false);
    expect(HAS_CMD.test('```\necho hi\n```')).toBe(false);
  });

  it('expands inline and fenced commands, leaving literals alone', async () => {
    const text = 'a: !`echo one`\nKEY=!`echo no`\n```!\necho two\necho three\n```\nend';
    expect(await expandCommands(text, tmpdir())).toBe('a: one\nKEY=!`echo no`\ntwo\nthree\nend');
  });

  it('runs commands in the given cwd', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dyn-')));
    expect(await expandCommands('!`pwd`', dir)).toBe(dir);
  });
});

describe('buildSkillPrompt', () => {
  it('matches pi skill block format', () => {
    expect(buildSkillPrompt('x', '/s/x/SKILL.md', 'body', ' arg ')).toBe(
      '<skill name="x" location="/s/x/SKILL.md">\nReferences are relative to /s/x.\n\nbody\n</skill>\n\narg',
    );
    expect(buildSkillPrompt('x', '/s/x/SKILL.md', 'body', undefined)).not.toContain('\n\n\n');
  });
});

describe('normalizeReadPath', () => {
  it('strips @ and expands ~', () => {
    expect(normalizeReadPath('@/nonexistent/a', '/cwd')).toBe('/nonexistent/a');
    expect(normalizeReadPath('~/nonexistent-dyn/a', '/cwd')).toBe(join(homedir(), 'nonexistent-dyn/a'));
    expect(normalizeReadPath('rel/a', '/nonexistent-cwd')).toBe('/nonexistent-cwd/rel/a');
  });
});

function fakePi(skillPaths: string[]) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, h),
    getCommands: () =>
      skillPaths.map((path) => ({
        name: 'skill:x',
        source: 'skill',
        sourceInfo: { path, source: 'auto', scope: 'user', origin: 'top-level' },
      })),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

describe('registered-skill allowlist', () => {
  it('matches symlinked aliases of registered skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyn-'));
    const real = join(dir, 'SKILL.md');
    writeFileSync(real, '');
    const link = join(dir, 'alias.md');
    symlinkSync(real, link);
    expect(registeredSkillPaths(fakePi([real]).pi).has(normalizeReadPath(link, '/'))).toBe(true);
  });

  it('never runs commands from an unregistered SKILL.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyn-'));
    const marker = join(dir, 'pwned');
    const { pi, handlers } = fakePi([join(dir, 'registered', 'SKILL.md')]);
    dynamicSkills(pi);
    const notify = vi.fn();
    const result = await handlers.get('tool_result')!(
      {
        toolName: 'read',
        input: { path: join(dir, 'evil', 'SKILL.md') },
        content: [{ type: 'text', text: `!\`touch ${marker}\`` }],
      },
      { cwd: dir, ui: { notify } },
    );
    expect(result).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('unregistered'), 'warning');
    expect(existsSync(marker)).toBe(false);
  });

  it('expands a registered SKILL.md read via a relative path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyn-'));
    const skill = join(dir, 'SKILL.md');
    writeFileSync(skill, '');
    const { pi, handlers } = fakePi([skill]);
    dynamicSkills(pi);
    const result = (await handlers.get('tool_result')!(
      { toolName: 'read', input: { path: 'SKILL.md' }, content: [{ type: 'text', text: 'x: !`echo hi`' }] },
      { cwd: dir, ui: { notify: vi.fn() } },
    )) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe('x: hi');
  });
});
