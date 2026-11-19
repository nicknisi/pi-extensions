import type { RunArtifact } from '@nicknisi/pi-shared';

export type FleetScope = 'current' | 'all';

/**
 * Merge persisted artifacts with this process's live run records, newest
 * first. Live wins for status/timing, but live records carry no output, so
 * the artifact's output is kept.
 */
export function mergeFleet(persisted: RunArtifact[], live: RunArtifact[]): RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const record of persisted) byId.set(record.runId, record);
  for (const record of live) {
    const stored = byId.get(record.runId);
    byId.set(record.runId, { ...stored, ...record, output: record.output ?? stored?.output });
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Scope the operational fleet to active runs owned by the current pi session.
 * Persisted machine-wide history is available only through the explicit `all`
 * scope. A session without a persisted file cannot own persisted run records.
 */
export function scopeFleetRuns(
  runs: RunArtifact[],
  scope: FleetScope,
  parentSession: string | undefined,
): RunArtifact[] {
  if (scope === 'all') return runs;
  if (!parentSession) return [];
  return runs.filter(
    (run) => (run.status === 'queued' || run.status === 'running') && run.ownerSession === parentSession,
  );
}
