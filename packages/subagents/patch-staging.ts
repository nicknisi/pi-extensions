/** Helpers behind /patches: which patches to offer, single-hunk sub-patches, and decision persistence. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedPatch, PatchHunk, RunArtifact } from '@nicknisi/pi-shared';

export interface PatchState {
  version: 1;
  decisions: Record<string, { decision: 'applied' | 'discarded'; at: number }>;
}

/** Read `<dir>/state.json`; missing or corrupt state starts fresh. */
export function loadPatchState(dir: string): PatchState {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as Partial<PatchState>;
    if (j && j.decisions) return { version: 1, decisions: j.decisions };
  } catch {
    // missing/corrupt state — start fresh
  }
  return { version: 1, decisions: {} };
}

let tmpSeq = 0;

/**
 * Persist one decision as a read-modify-write of the CURRENT state.json
 * (re-read immediately before writing, then temp file + rename) so decisions
 * made concurrently by another pi process are merged, not overwritten.
 * Returns the merged state. Best-effort: a failed write just means the patch
 * re-appears next time.
 */
export function recordPatchDecision(
  dir: string,
  patchPath: string,
  decision: 'applied' | 'discarded',
  at: number = Date.now(),
): PatchState {
  const state = loadPatchState(dir);
  state.decisions[patchPath] = { decision, at };
  const file = path.join(dir, 'state.json');
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
  return state;
}

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
