/** Pure helpers behind /patches: which patches to offer, and single-hunk sub-patches. */

import type { ParsedPatch, PatchHunk, RunArtifact } from '@nicknisi/pi-shared';

export interface PatchFileRef {
  runId: string;
  patchPath: string;
}

export interface PatchCandidate extends PatchFileRef {
  /** The run artifact, when one exists (orphan patches have none). */
  run: RunArtifact | undefined;
}

/**
 * Keep only patches worth stamping and offering: every patch without an
 * apply/discard decision, from any namespace or repository, orphans included.
 * Decided patches are skipped up front so they never pay for a pre-flight.
 */
export function selectPendingPatches(
  files: PatchFileRef[],
  artifacts: Map<string, RunArtifact>,
  decisions: Record<string, unknown>,
): PatchCandidate[] {
  return files
    .filter((file) => !decisions[file.patchPath])
    .map((file) => ({ ...file, run: artifacts.get(file.runId) }));
}

/** A standalone patch holding one hunk under its owning file's header, for `git apply`. */
export function buildHunkPatch(parsed: ParsedPatch, hunk: PatchHunk): string | undefined {
  const file = parsed.files[hunk.fileIndex];
  if (!file) return undefined;
  return [...file.header, hunk.header, ...hunk.body].join('\n') + '\n';
}

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
