import type { SpawnResult } from '@nicknisi/pi-shared';

/** How much of a child's answer reaches the model, for foreground results and background notices alike. */
export const MAX_TASK_OUTPUT_CHARS = 4000;

/**
 * The transcript message a finished background run posts, with its delivery options. A fresh run's
 * notice carries the answer and wakes the parent: it starts a turn when the session is idle, or is
 * steered in at the next tool boundary when busy, so the model never has to poll `fleet`. A resumed
 * run finishes after the session was reopened, with its original caller gone, so its notice waits
 * for the next prompt rather than starting work unprompted (as resumed workflows do). A stopped run
 * (`aborted`: a cancel, or the session quitting or switching with HOST_EXIT) doesn't wake it either:
 * whoever stopped it already knows, and a turn started during shutdown would outlive the session.
 */
export function backgroundNotice(runId: string, label: string, result: SpawnResult, resumed: boolean) {
  const name = `${resumed ? 'Resumed' : 'Background'} subagent ${runId.slice(0, 8)} (${label})`;
  const content = result.ok
    ? `${name} completed\n\n${result.text.slice(0, MAX_TASK_OUTPUT_CHARS)}`
    : `${name} failed: ${result.error}${result.text ? `\n\nPartial output:\n${result.text.slice(0, 1000)}` : ''}`;
  return {
    message: { customType: 'subagents:background', content, display: true, details: { runId, ok: result.ok } },
    options:
      resumed || (!result.ok && result.kind === 'aborted') ? {} : { triggerTurn: true, deliverAs: 'steer' as const },
  };
}
