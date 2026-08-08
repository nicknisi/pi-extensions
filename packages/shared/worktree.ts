/**
 * Pi-free git worktree primitives for subagent isolation.
 *
 * Each subagent run that edits code gets a DETACHED worktree under
 * <agentDir>/subagent-worktrees/<runId>, branched from HEAD. On completion,
 * captureHandoff() snapshots the worktree's full delta (including untracked
 * files, which a plain `git diff HEAD` silently misses) as an untruncated
 * patch file; removeWorktree() tears the worktree down.
 *
 * Every git call is spawnSync with a generous timeout and never throws —
 * failures surface as error strings (or empty results) so callers can treat
 * worktree setup/teardown as best-effort.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const GIT_TIMEOUT_MS = 30_000;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function git(args: string[], cwd?: string): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const res = spawnSync('git', args, {
      ...(cwd !== undefined ? { cwd } : {}),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    });
    if (res.error) return { ok: false, error: res.error.message };
    if (res.status !== 0) {
      return { ok: false, error: (res.stderr ?? '').trim() || `git exited with status ${res.status}` };
    }
    return { ok: true, stdout: res.stdout ?? '' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Repo toplevel for cwd, or null when cwd isn't inside a git repo. Never throws. */
export function findRepoRoot(cwd: string): string | null {
  const res = git(['-C', cwd, 'rev-parse', '--show-toplevel']);
  return res.ok ? res.stdout.trim() || null : null;
}

/**
 * Create a detached worktree for runId at <agentDir>/subagent-worktrees/<runId>
 * from HEAD. Leftovers from a prior attempt with the same runId are removed
 * first; a failed add is retried once after pruning stale registrations.
 */
export function addWorktree(repoRoot: string, runId: string): { path: string } | { error: string } {
  const root = path.join(agentDir(), 'subagent-worktrees');
  const wtPath = path.join(root, runId);
  try {
    fs.mkdirSync(root, { recursive: true });
    if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
  } catch (err) {
    return { error: errorMessage(err) };
  }

  let res = git(['-C', repoRoot, 'worktree', 'add', '--detach', wtPath, 'HEAD']);
  if (!res.ok) {
    // Clear whatever the failed attempt left behind and forget any stale
    // worktree registration for the path, then retry exactly once.
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    git(['-C', repoRoot, 'worktree', 'prune']);
    res = git(['-C', repoRoot, 'worktree', 'add', '--detach', wtPath, 'HEAD']);
  }
  return res.ok ? { path: wtPath } : { error: res.error };
}

/**
 * Snapshot the worktree's full delta against HEAD. Stages everything first
 * (`git add -A`) so UNTRACKED files are captured in the cached diff — the fix
 * for `git diff HEAD` missing newly created files. The patch is written
 * UNTRUNCATED to patchPath; when nothing changed, no file is written and the
 * returned patchPath is null.
 */
export function captureHandoff(
  worktreePath: string,
  patchPath: string,
): { status: string; patchPath: string | null; changedFiles: number } {
  git(['-C', worktreePath, 'add', '-A']);
  const statusRes = git(['-C', worktreePath, 'status', '--porcelain']);
  const status = statusRes.ok ? statusRes.stdout : '';
  const changedFiles = status.split('\n').filter((line) => line.trim() !== '').length;
  if (changedFiles === 0) return { status, patchPath: null, changedFiles };

  const diff = git(['-C', worktreePath, 'diff', '--cached', 'HEAD']);
  if (!diff.ok || diff.stdout === '') return { status, patchPath: null, changedFiles };
  try {
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    fs.writeFileSync(patchPath, diff.stdout);
    return { status, patchPath, changedFiles };
  } catch {
    return { status, patchPath: null, changedFiles };
  }
}

/**
 * Remove a worktree. Prefers `git worktree remove --force` when repoRoot is a
 * live repo (keeps git's worktree registry clean); falls back to rmSync.
 * Never throws.
 */
export function removeWorktree(repoRoot: string | null, wtPath: string): void {
  try {
    if (repoRoot !== null && findRepoRoot(repoRoot) !== null) {
      const res = git(['-C', repoRoot, 'worktree', 'remove', '--force', wtPath]);
      if (res.ok) return;
    }
    fs.rmSync(wtPath, { recursive: true, force: true });
  } catch {
    // cleanup must never throw
  }
}
