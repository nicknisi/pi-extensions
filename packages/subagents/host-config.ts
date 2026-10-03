/**
 * Host-level configuration for subagent children, plus the per-task `cwd`
 * resolver.
 *
 * Children are hermetic: a fresh model runtime, no user extensions, and the
 * parent's cwd. Two kinds of host need to widen that without giving the model
 * any new authority:
 *
 * - A harness whose session cwd is a *workspace root* holding several
 *   repository checkouts (e.g. `repos/<owner>__<name>`). Worktree isolation
 *   resolves the repository from the child's cwd, so such a host needs a
 *   per-task `cwd` that stays inside the session cwd.
 * - A harness whose model routing lives in an extension — a brokered provider
 *   registered with `pi.registerProvider` — has no working model in a child
 *   unless that extension loads there too. `childExtensionPaths` names the
 *   extension files every child loads. It is host configuration (factory
 *   option or `<agentDir>/subagents.json`), never model input.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** File name under the agent dir, e.g. `~/.pi/agent/subagents.json`. */
export const HOST_CONFIG_FILE = 'subagents.json';

export interface SubagentsHostConfig {
  /** Extension files every child loads. Absolute, or relative to the agent dir. */
  childExtensionPaths?: string[] | undefined;
}

export interface HostConfigFileResult {
  config: SubagentsHostConfig;
  /** Human-readable problems with the file; the config is still usable. */
  warnings: string[];
}

/**
 * Read `<agentDir>/subagents.json`. A missing file is not an error. A file
 * that is unparseable or has the wrong shape yields an empty config plus a
 * warning — misconfiguration must never take the whole extension down.
 */
export function readHostConfigFile(agentDir: string): HostConfigFileResult {
  const file = path.join(agentDir, HOST_CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: {}, warnings: [] };
    return { config: {}, warnings: [`${file}: unreadable (${(err as Error).message})`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { config: {}, warnings: [`${file}: invalid JSON (${(err as Error).message})`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: {}, warnings: [`${file}: expected a JSON object`] };
  }

  const warnings: string[] = [];
  const config: SubagentsHostConfig = {};
  const raw = (parsed as Record<string, unknown>).childExtensionPaths;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      warnings.push(`${file}: childExtensionPaths must be an array of strings`);
    } else {
      const strings = raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
      if (strings.length !== raw.length) {
        warnings.push(`${file}: childExtensionPaths entries must be non-empty strings; ignored the rest`);
      }
      config.childExtensionPaths = strings;
    }
  }
  return { config, warnings };
}

export interface ChildExtensionPaths {
  /** Absolute paths to existing files, deduplicated, in source order. */
  paths: string[];
  /** Configured entries that do not resolve to a file; skipped, not fatal. */
  missing: string[];
}

/**
 * Merge child extension path lists (factory option first, then the config
 * file), resolve relative entries against the agent dir, drop duplicates, and
 * separate entries that do not exist so the host can warn about them.
 */
export function resolveChildExtensionPaths(
  agentDir: string,
  ...sources: Array<readonly string[] | undefined>
): ChildExtensionPaths {
  const seen = new Set<string>();
  const paths: string[] = [];
  const missing: string[] = [];
  for (const source of sources) {
    for (const entry of source ?? []) {
      const resolved = path.isAbsolute(entry) ? path.normalize(entry) : path.resolve(agentDir, entry);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (isFile(resolved)) paths.push(resolved);
      else missing.push(resolved);
    }
  }
  return { paths, missing };
}

export type TaskCwdResolution = { ok: true; cwd: string } | { ok: false; error: string };

/**
 * Resolve a task's `cwd` against the session cwd. The result must be an
 * existing directory inside the session cwd — checked on real paths, so a
 * symlink cannot escape the jail. Absent or empty means the session cwd.
 */
export function resolveTaskCwd(sessionCwd: string, taskCwd: string | undefined): TaskCwdResolution {
  if (taskCwd === undefined || taskCwd.trim() === '') return { ok: true, cwd: sessionCwd };
  if (path.isAbsolute(taskCwd)) {
    return { ok: false, error: `cwd must be relative to the session cwd, got absolute path ${taskCwd}` };
  }
  const candidate = path.resolve(sessionCwd, taskCwd);
  if (!isDirectory(candidate)) {
    return { ok: false, error: `cwd ${taskCwd} does not exist or is not a directory under ${sessionCwd}` };
  }
  const realRoot = realpath(sessionCwd);
  const realCandidate = realpath(candidate);
  if (realRoot === null || realCandidate === null) {
    return { ok: false, error: `cwd ${taskCwd} could not be resolved` };
  }
  const relative = path.relative(realRoot, realCandidate);
  if (relative === '') return { ok: true, cwd: candidate };
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: `cwd ${taskCwd} escapes the session cwd ${sessionCwd}` };
  }
  return { ok: true, cwd: candidate };
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function realpath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}
