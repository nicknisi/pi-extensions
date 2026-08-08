/**
 * Tests for the pi-free parts of the subagent runtime: artifact GC/reaping
 * (sweepRunArtifacts) and the git worktree primitives. createSubagentRuntime
 * itself needs pi's SDK loader and is exercised by the live smoke suite.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_RETENTION_MS, sweepRunArtifacts, type RunArtifact } from './subagents.js';
import { addWorktree, captureHandoff, findRepoRoot, removeWorktree } from './worktree.js';

const tmpdirs: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-test-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeArtifact(root: string, ns: string, record: Partial<RunArtifact> & { runId: string }): string {
  const dir = path.join(root, ns);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.runId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      namespace: ns,
      status: 'completed',
      promptPreview: 'test',
      startedAt: Date.now(),
      ...record,
    }),
  );
  return file;
}

describe('sweepRunArtifacts', () => {
  it('deletes records older than the retention window, plus patch siblings', () => {
    const root = tmpRoot();
    const now = Date.now();
    const old = writeArtifact(root, 'subagents', {
      runId: 'old-run',
      startedAt: now - ARTIFACT_RETENTION_MS - 60_000,
      endedAt: now - ARTIFACT_RETENTION_MS - 50_000,
    });
    fs.writeFileSync(old.replace(/\.json$/, '.patch'), 'diff --git …');
    const fresh = writeArtifact(root, 'subagents', { runId: 'fresh-run', endedAt: now - 1000 });

    const result = sweepRunArtifacts(root, { now });
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(old.replace(/\.json$/, '.patch'))).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('reaps queued/running records whose hostPid belongs to a dead process', () => {
    const root = tmpRoot();
    const ghost = writeArtifact(root, 'codemode', {
      runId: 'ghost-run',
      status: 'running',
      hostPid: 999999999, // not us, not anyone
    });
    const ours = writeArtifact(root, 'codemode', {
      runId: 'our-run',
      status: 'running',
      hostPid: process.pid,
    });

    const result = sweepRunArtifacts(root);
    expect(result.reaped).toBe(1);
    const reaped = JSON.parse(fs.readFileSync(ghost, 'utf8'));
    expect(reaped.status).toBe('aborted');
    expect(reaped.error).toMatch(/host pi process exited/i);
    expect(JSON.parse(fs.readFileSync(ours, 'utf8')).status).toBe('running');
  });

  it('does not reap records without a hostPid (pre-field artifacts)', () => {
    const root = tmpRoot();
    writeArtifact(root, 'subagents', { runId: 'legacy-run', status: 'running' });
    const result = sweepRunArtifacts(root);
    expect(result.reaped).toBe(0);
  });

  it('returns zeros on a missing root and never throws', () => {
    expect(sweepRunArtifacts(path.join(tmpRoot(), 'nope'))).toEqual({ deleted: 0, reaped: 0 });
  });
});

describe('worktree primitives', () => {
  function gitRepo(): string {
    const repo = tmpRoot();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init');
    return repo;
  }

  it('findRepoRoot finds the toplevel and returns null outside a repo', () => {
    const repo = gitRepo();
    expect(findRepoRoot(path.join(repo))).toBe(fs.realpathSync(repo));
    expect(findRepoRoot('/')).toBeNull();
  });

  it('addWorktree → child changes stay out of the main tree → captureHandoff incl. untracked → removeWorktree', () => {
    const repo = gitRepo();
    const added = addWorktree(repo, 'test-run-1');
    expect('path' in added).toBe(true);
    if (!('path' in added)) return;

    // Tracked edit + untracked new file inside the worktree.
    fs.writeFileSync(path.join(added.path, 'tracked.txt'), 'hello');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: added.path });
    fs.writeFileSync(path.join(added.path, 'untracked-new-file.txt'), 'brand new');

    // Main tree is untouched.
    expect(fs.existsSync(path.join(repo, 'tracked.txt'))).toBe(false);

    const patchPath = path.join(tmpRoot(), 'handoff.patch');
    const handoff = captureHandoff(added.path, patchPath);
    expect(handoff.patchPath).toBe(patchPath);
    expect(handoff.changedFiles).toBe(2);
    const patch = fs.readFileSync(patchPath, 'utf8');
    expect(patch).toContain('tracked.txt');
    expect(patch).toContain('untracked-new-file.txt'); // the whole point: untracked captured

    removeWorktree(repo, added.path);
    expect(fs.existsSync(added.path)).toBe(false);
  });

  it('captureHandoff reports no patch when nothing changed', () => {
    const repo = gitRepo();
    const added = addWorktree(repo, 'test-run-clean');
    if (!('path' in added)) throw new Error('setup failed');
    const handoff = captureHandoff(added.path, path.join(tmpRoot(), 'none.patch'));
    expect(handoff.patchPath).toBeNull();
    expect(handoff.changedFiles).toBe(0);
    removeWorktree(repo, added.path);
  });
});
