import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, type RunArtifact } from '@nicknisi/pi-shared';
import { buildHunkPatch, mapLimit, selectPendingPatches } from './patch-staging.js';

function artifact(runId: string, repoRoot?: string): RunArtifact {
  return {
    runId,
    namespace: 'subagents',
    status: 'completed',
    promptPreview: runId,
    startedAt: 1,
    worktree: { path: `/wt/${runId}`, ...(repoRoot ? { repoRoot } : {}) },
  };
}

describe('selectPendingPatches', () => {
  it('keeps every undecided patch, from any repo, orphans included', () => {
    const files = ['here', 'decided', 'other-repo', 'no-root', 'no-artifact'].map((runId) => ({
      runId,
      patchPath: `/runs/subagents/${runId}.patch`,
    }));
    const artifacts = new Map(
      [
        artifact('here', '/repo'),
        artifact('decided', '/repo'),
        artifact('other-repo', '/elsewhere'),
        artifact('no-root'),
      ].map((a) => [a.runId, a] as const),
    );
    const decisions = { '/runs/subagents/decided.patch': { decision: 'applied', at: 1 } };
    const pending = selectPendingPatches(files, artifacts, decisions);
    expect(pending.map((c) => c.runId)).toEqual(['here', 'other-repo', 'no-root', 'no-artifact']);
    expect(pending[0]!.run?.runId).toBe('here');
    expect(pending[3]!.run).toBeUndefined();
  });
});

describe('buildHunkPatch', () => {
  it('reconstructs one hunk under its owning file header', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-one',
      '+uno',
      '@@ -10,1 +10,1 @@',
      '-ten',
      '+diez',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-b',
      '+B',
      '',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    const second = parsed.hunks[1]!;
    const sub = buildHunkPatch(parsed, second)!;
    expect(sub).toBe(
      [
        'diff --git a/a.txt b/a.txt',
        'index 1..2 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -10,1 +10,1 @@',
        '-ten',
        '+diez',
        '',
      ].join('\n'),
    );
    expect(buildHunkPatch(parsed, { ...second, fileIndex: 99 })).toBeUndefined();
  });
});

describe('mapLimit', () => {
  it('bounds concurrency and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async (n: number) => n)).toEqual([]);
  });
});
