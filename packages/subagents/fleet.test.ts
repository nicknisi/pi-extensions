import { describe, expect, it } from 'vitest';
import type { RunArtifact } from '@nicknisi/pi-shared';
import { scopeFleetRuns } from './fleet.js';

function run(runId: string, status: RunArtifact['status'], ownerSession?: string): RunArtifact {
  return {
    runId,
    namespace: 'test',
    status,
    promptPreview: runId,
    startedAt: 1,
    ...(ownerSession ? { ownerSession } : {}),
  };
}

describe('scopeFleetRuns', () => {
  const currentSession = '/sessions/current.jsonl';
  const otherSession = '/sessions/other.jsonl';
  const runs = [
    run('current-running', 'running', currentSession),
    run('current-queued', 'queued', currentSession),
    run('current-completed', 'completed', currentSession),
    run('other-running', 'running', otherSession),
    run('legacy-running', 'running'),
  ];

  it('shows only active runs owned by the current session by default', () => {
    expect(scopeFleetRuns(runs, 'current', currentSession).map((item) => item.runId)).toEqual([
      'current-running',
      'current-queued',
    ]);
  });

  it('shows no default fleet when the current session has no active runs', () => {
    expect(scopeFleetRuns(runs, 'current', '/sessions/empty.jsonl')).toEqual([]);
    expect(scopeFleetRuns(runs, 'current', undefined)).toEqual([]);
  });

  it('returns machine-wide persisted history only for the explicit all scope', () => {
    expect(scopeFleetRuns(runs, 'all', currentSession)).toEqual(runs);
  });
});
