/**
 * Agent profiles — named personas for dispatch.
 *
 * A profile is a markdown file: YAML-ish frontmatter on top, a persona system
 * prompt below. It bundles a skill basket, a tool allowlist, and an optional
 * model so `dispatch` (and the `&` prefix) can launch a child as a named
 * specialist instead of hand-assembling tools/skills/prompt per task:
 *
 *     ---
 *     name: reviewer
 *     description: Code review — correctness, tests, simplicity
 *     skills: pr, review-checklist
 *     tools: read, grep, find, ls
 *     model: anthropic/claude-sonnet-4-5
 *     ---
 *     Review the change against the task. Prefer the smallest correct fix.
 *
 * Discovery (first-wins by name, highest precedence first):
 *   1. `<cwd>/.pi/agents/*.md`        — project profiles
 *   2. `<agentDir>/agents/*.md`       — user profiles
 *   3. host-provided extra dirs       — e.g. a distribution's bundled defaults
 *
 * The frontmatter parser is deliberately small, not a YAML implementation:
 * `key: value` scalars, `key:` followed by `- item` block lists, and
 * comma-separated scalars for list fields. Unknown keys are ignored so files
 * shared with other agent-file consumers (Claude Code, pi-subagents) load.
 *
 * Skills resolve at dispatch time against the parent session's registered
 * skill catalog (bare names) or relative to the profile file (path entries).
 * Missing skills warn; they never fail the dispatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AgentProfile {
  name: string;
  description: string;
  /** Skill names (resolved via the session skill registry) or `.md` paths relative to the profile file. */
  skills: string[];
  /** Tool allowlist. Omitted = dispatch's read-only default. */
  tools?: string[] | undefined;
  model?: string | undefined;
  /** Default the task to worktree isolation (the natural home for builder personas). */
  worktree?: boolean | undefined;
  /** Replace pi's system prompt with the persona prompt instead of appending. */
  replace?: boolean | undefined;
  /** Persona system prompt (frontmatter body). Empty string when absent. */
  prompt: string;
  /** Source file, for diagnostics and relative skill resolution. */
  path: string;
  scope: 'project' | 'user' | 'extra';
}

/** The task fields a profile can default. Structural so index.ts's TaskSpec satisfies it. */
export interface ProfileTaskFields {
  agent?: string | undefined;
  model?: string | undefined;
  tools?: string[] | undefined;
  systemPrompt?: string | undefined;
  worktree?: boolean | undefined;
  skillPaths?: string[] | undefined;
  replaceSystemPrompt?: boolean | undefined;
}

export type ParseResult = { ok: true; profile: AgentProfile } | { ok: false; error: string };

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first!)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => stripQuotes(item))
    .filter((item) => item.length > 0);
}

/**
 * Parse one profile file. Returns a typed error (never throws) so discovery
 * can collect diagnostics and a strict `profile:` lookup can explain itself.
 */
export function parseAgentProfile(content: string, filePath: string, scope: AgentProfile['scope']): ParseResult {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { ok: false, error: `${filePath}: missing frontmatter (file must start with ---)` };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { ok: false, error: `${filePath}: unterminated frontmatter (no closing ---)` };
  }

  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let currentList: string[] | null = null;

  for (let i = 1; i < close; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (currentList) {
        const item = stripQuotes(trimmed.slice(1));
        if (item) currentList.push(item);
      }
      // A stray `- item` with no preceding `key:` is ignored.
      continue;
    }

    const colon = trimmed.indexOf(':');
    if (colon === -1) continue; // not key: value — ignore, stay lenient
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (value === '') {
      // `key:` opens a block list (only meaningful for list fields).
      currentList = [];
      lists.set(key, currentList);
    } else {
      currentList = null;
      scalars.set(key, stripQuotes(value));
    }
  }

  const listField = (key: string): string[] | undefined => {
    const block = lists.get(key);
    if (block && block.length > 0) return block;
    const scalar = scalars.get(key);
    if (scalar) return splitList(scalar);
    if (block) return []; // explicit empty block
    return undefined;
  };

  const boolField = (key: string): boolean | undefined => {
    const value = scalars.get(key);
    if (value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined; // unrecognized — ignore rather than guess
  };

  const stem = path.basename(filePath).replace(/\.md$/i, '');
  const name = scalars.get('name') ?? stem;
  const description = scalars.get('description');
  if (!description) {
    return { ok: false, error: `${filePath}: missing required 'description' frontmatter field` };
  }

  const profile: AgentProfile = {
    name,
    description,
    skills: listField('skills') ?? [],
    prompt: lines
      .slice(close + 1)
      .join('\n')
      .trim(),
    path: filePath,
    scope,
  };
  const tools = listField('tools');
  if (tools) profile.tools = tools;
  const model = scalars.get('model');
  if (model) profile.model = model;
  const worktree = boolField('worktree');
  if (worktree !== undefined) profile.worktree = worktree;
  const replace = boolField('replace');
  if (replace !== undefined) profile.replace = replace;
  return { ok: true, profile };
}

export interface ProfileDir {
  dir: string;
  scope: AgentProfile['scope'];
}

/** Ordered search dirs, highest precedence first. Missing dirs are fine. */
export function profileSearchDirs(cwd: string, agentDir: string, extraDirs: string[]): ProfileDir[] {
  return [
    { dir: path.join(cwd, '.pi', 'agents'), scope: 'project' as const },
    { dir: path.join(agentDir, 'agents'), scope: 'user' as const },
    ...extraDirs.map((dir) => ({ dir, scope: 'extra' as const })),
  ];
}

export interface DiscoveredProfiles {
  /** name -> profile, first-wins across dirs in the given order. */
  profiles: Map<string, AgentProfile>;
  /** Parse failures, for strict-lookup diagnostics. */
  errors: string[];
}

export function discoverProfiles(dirs: ProfileDir[]): DiscoveredProfiles {
  const profiles = new Map<string, AgentProfile>();
  const errors: string[] = [];
  for (const { dir, scope } of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // dir absent — normal
    }
    for (const entry of entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(dir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const result = parseAgentProfile(content, filePath, scope);
      if (!result.ok) {
        errors.push(result.error);
        continue;
      }
      if (!profiles.has(result.profile.name)) {
        profiles.set(result.profile.name, result.profile);
      }
    }
  }
  return { profiles, errors };
}

export interface ResolvedSkills {
  skillPaths: string[];
  missing: string[];
}

/**
 * Resolve a profile's skill entries to SKILL.md paths. Bare names look up in
 * `skillRegistry` (skill name -> SKILL.md path, from the parent session's
 * catalog); entries containing a path separator or ending in `.md` resolve
 * relative to the profile file. Missing entries are reported, not fatal.
 */
export function resolveProfileSkills(profile: AgentProfile, skillRegistry: Map<string, string>): ResolvedSkills {
  const skillPaths: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const entry of profile.skills) {
    let resolved: string | undefined;
    if (entry.includes('/') || entry.toLowerCase().endsWith('.md')) {
      const candidate = path.resolve(path.dirname(profile.path), entry);
      if (fs.existsSync(candidate)) resolved = candidate;
    } else {
      resolved = skillRegistry.get(entry);
    }
    if (!resolved) {
      missing.push(entry);
      continue;
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      skillPaths.push(resolved);
    }
  }
  return { skillPaths, missing };
}

/**
 * Merge a profile into a task spec. Explicit spec fields win — call beats
 * persona, persona beats defaults. `replace` applies only when the persona's
 * own prompt is used (an explicit systemPrompt keeps append semantics).
 */
export function applyProfile<T extends ProfileTaskFields>(spec: T, profile: AgentProfile, skillPaths: string[]): T {
  const merged: T = { ...spec };
  if (merged.agent === undefined) merged.agent = profile.name;
  if (merged.model === undefined && profile.model !== undefined) merged.model = profile.model;
  if (merged.tools === undefined && profile.tools !== undefined) merged.tools = profile.tools;
  if (merged.worktree === undefined && profile.worktree !== undefined) merged.worktree = profile.worktree;
  if (skillPaths.length > 0) merged.skillPaths = skillPaths;
  if (merged.systemPrompt === undefined && profile.prompt !== '') {
    merged.systemPrompt = profile.prompt;
    if (profile.replace) merged.replaceSystemPrompt = true;
  }
  return merged;
}
