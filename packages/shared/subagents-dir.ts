/**
 * One env override for every file the subagent runtime writes.
 *
 * When PI_SUBAGENTS_DIR is set (e.g. by a host that confines a job to its own
 * directory), run artifacts, patch state, worktrees, child session mirrors and
 * workflow run dirs all live under it. Unset, each caller keeps its usual
 * location under the pi agent dir. Read at call time, never at module load, so
 * a host's env (or a test's) applies.
 */

import * as path from 'node:path';

export const SUBAGENTS_DIR_ENV = 'PI_SUBAGENTS_DIR';

/** `<$PI_SUBAGENTS_DIR>/<leaf>` when the override is set, else undefined (caller's default). */
export function subagentsDir(
  leaf: 'runs' | 'patches' | 'worktrees' | 'sessions' | 'workflow-runs',
): string | undefined {
  const root = process.env[SUBAGENTS_DIR_ENV];
  return root ? path.resolve(root, leaf) : undefined;
}
