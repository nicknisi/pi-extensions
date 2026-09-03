import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyProfile,
  discoverProfiles,
  parseAgentProfile,
  profileSearchDirs,
  resolveProfileSkills,
  type AgentProfile,
  type ProfileTaskFields,
} from './profiles.js';

type Spec = ProfileTaskFields & { task: string };

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'profiles-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: 'reviewer',
    description: 'Code review',
    skills: [],
    prompt: '',
    path: '/profiles/reviewer.md',
    scope: 'user',
    ...overrides,
  };
}

describe('parseAgentProfile', () => {
  it('parses frontmatter scalars, comma lists, and the prompt body', () => {
    const content = [
      '---',
      'name: reviewer',
      'description: Code review — correctness, tests, simplicity',
      'skills: pr, review-checklist',
      'tools: read, grep, find, ls',
      'model: anthropic/claude-sonnet-4-5',
      'worktree: true',
      'replace: true',
      '---',
      '',
      'Review the change against the task.',
    ].join('\n');
    const result = parseAgentProfile(content, '/x/reviewer.md', 'user');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({
      name: 'reviewer',
      description: 'Code review — correctness, tests, simplicity',
      skills: ['pr', 'review-checklist'],
      tools: ['read', 'grep', 'find', 'ls'],
      model: 'anthropic/claude-sonnet-4-5',
      worktree: true,
      replace: true,
      prompt: 'Review the change against the task.',
      scope: 'user',
    });
  });

  it('parses block lists and quoted scalars', () => {
    const content = [
      '---',
      'description: "UI work"',
      'skills:',
      '  - claymorphism',
      '  - web-perf',
      'tools:',
      "  - 'read'",
      '  - edit',
      '---',
      'Persona.',
    ].join('\n');
    const result = parseAgentProfile(content, '/x/ui-engineer.md', 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.name).toBe('ui-engineer'); // falls back to file stem
    expect(result.profile.description).toBe('UI work');
    expect(result.profile.skills).toEqual(['claymorphism', 'web-perf']);
    expect(result.profile.tools).toEqual(['read', 'edit']);
  });

  it('ignores unknown keys, comments, and blank lines', () => {
    const content = [
      '---',
      '# a comment',
      'description: Minimal',
      'inheritSkills: false', // another harness's field
      '',
      'aliases: rev, r',
      '---',
    ].join('\n');
    const result = parseAgentProfile(content, '/x/min.md', 'extra');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.prompt).toBe('');
    expect(result.profile.tools).toBeUndefined();
    expect(result.profile.worktree).toBeUndefined();
  });

  it('rejects files without frontmatter, unterminated frontmatter, or missing description', () => {
    expect(parseAgentProfile('just text', '/x/a.md', 'user').ok).toBe(false);
    expect(parseAgentProfile('---\ndescription: x', '/x/b.md', 'user').ok).toBe(false);
    const missing = parseAgentProfile('---\nname: a\n---\nbody', '/x/c.md', 'user');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toContain('description');
  });
});

describe('discoverProfiles', () => {
  it('applies first-wins precedence across dirs and collects parse errors', () => {
    const projectDir = tempDir();
    const userDir = tempDir();
    writeFileSync(join(projectDir, 'reviewer.md'), '---\ndescription: project reviewer\n---\n');
    writeFileSync(join(userDir, 'reviewer.md'), '---\ndescription: user reviewer\n---\n');
    writeFileSync(join(userDir, 'scout.md'), '---\ndescription: user scout\n---\n');
    writeFileSync(join(userDir, 'broken.md'), 'no frontmatter');
    writeFileSync(join(userDir, 'notes.txt'), 'ignored');

    const { profiles, errors } = discoverProfiles([
      { dir: projectDir, scope: 'project' },
      { dir: userDir, scope: 'user' },
      { dir: join(userDir, 'does-not-exist'), scope: 'extra' },
    ]);

    expect(profiles.get('reviewer')?.description).toBe('project reviewer');
    expect(profiles.get('reviewer')?.scope).toBe('project');
    expect(profiles.get('scout')?.scope).toBe('user');
    expect(profiles.size).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('broken.md');
  });
});

describe('profileSearchDirs', () => {
  it('orders project, user, then extra dirs', () => {
    const dirs = profileSearchDirs('/repo', '/home/agent', ['/bundled/profiles']);
    expect(dirs.map((d) => d.dir)).toEqual([
      join('/repo', '.pi', 'agents'),
      join('/home/agent', 'agents'),
      '/bundled/profiles',
    ]);
    expect(dirs.map((d) => d.scope)).toEqual(['project', 'user', 'extra']);
  });
});

describe('resolveProfileSkills', () => {
  it('resolves bare names via the registry and path entries relative to the profile', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'local-skill'));
    writeFileSync(join(dir, 'local-skill', 'SKILL.md'), '---\nname: local\ndescription: x\n---\n');
    const p = profile({
      path: join(dir, 'reviewer.md'),
      skills: ['pr', 'local-skill/SKILL.md', 'pr', 'ghost'],
    });
    const registry = new Map([['pr', '/skills/pr/SKILL.md']]);

    const { skillPaths, missing } = resolveProfileSkills(p, registry);
    expect(skillPaths).toEqual(['/skills/pr/SKILL.md', join(dir, 'local-skill', 'SKILL.md')]);
    expect(missing).toEqual(['ghost']);
  });

  it('reports path entries that do not exist', () => {
    const p = profile({ path: '/nowhere/reviewer.md', skills: ['sub/SKILL.md'] });
    const { skillPaths, missing } = resolveProfileSkills(p, new Map());
    expect(skillPaths).toEqual([]);
    expect(missing).toEqual(['sub/SKILL.md']);
  });
});

describe('applyProfile', () => {
  const full = profile({
    tools: ['read', 'edit'],
    model: 'anthropic/claude-sonnet-4-5',
    worktree: true,
    prompt: 'Persona prompt.',
  });

  it('fills defaults from the profile', () => {
    const spec: Spec = { task: 'do it' };
    const merged = applyProfile(spec, full, ['/s/SKILL.md']);
    expect(merged).toMatchObject({
      agent: 'reviewer',
      model: 'anthropic/claude-sonnet-4-5',
      tools: ['read', 'edit'],
      worktree: true,
      skillPaths: ['/s/SKILL.md'],
      systemPrompt: 'Persona prompt.',
    });
    expect(merged.replaceSystemPrompt).toBeUndefined();
  });

  it('drops inherited bash from otherwise read-only profiles', () => {
    const explorer = profile({ tools: ['read', 'bash', 'grep', 'find', 'ls'] });
    const spec: Spec = { task: 'search' };
    const merged = applyProfile(spec, explorer, []);
    expect(merged.tools).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('keeps inherited bash when mutation is isolated or allowed', () => {
    const explorer = profile({ tools: ['read', 'bash', 'grep', 'find', 'ls'] });
    const isolated: Spec = { task: 'search', worktree: true };
    const allowed: Spec = { task: 'search', allowTreeMutation: true };
    expect(applyProfile(isolated, explorer, []).tools).toContain('bash');
    expect(applyProfile(allowed, explorer, []).tools).toContain('bash');
  });

  it('lets explicit spec fields win', () => {
    const spec: Spec = {
      task: 'do it',
      agent: 'label',
      model: 'openai/gpt-5-mini',
      tools: ['read', 'bash'],
      systemPrompt: 'custom',
      worktree: false,
    };
    const merged = applyProfile(spec, full, []);
    expect(merged).toMatchObject({
      agent: 'label',
      model: 'openai/gpt-5-mini',
      tools: ['read', 'bash'],
      systemPrompt: 'custom',
      worktree: false,
    });
    expect(merged.skillPaths).toBeUndefined();
  });

  it('applies replace only when the persona prompt is used', () => {
    const replacing = profile({ prompt: 'Persona.', replace: true });
    const bare: Spec = { task: 't' };
    const custom: Spec = { task: 't', systemPrompt: 'mine' };
    expect(applyProfile(bare, replacing, []).replaceSystemPrompt).toBe(true);
    expect(applyProfile(custom, replacing, []).replaceSystemPrompt).toBeUndefined();
  });
});
