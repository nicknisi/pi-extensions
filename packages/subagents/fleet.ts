import type { RunArtifact } from '@nicknisi/pi-shared';

export type FleetScope = 'current' | 'all';

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
