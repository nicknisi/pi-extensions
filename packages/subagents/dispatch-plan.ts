/** Pure dispatch planning: which tasks are refused, backgrounded, batched, or serialized. */

export const TREE_MUTATING_TOOLS = new Set(['edit', 'write', 'bash']);

/** The task fields planning looks at. Structural so index.ts's TaskSpec satisfies it. */
export interface PlanSpec {
  tools?: string[] | undefined;
  worktree?: boolean | undefined;
  allowTreeMutation?: boolean | undefined;
  background?: boolean | undefined;
}

export function wantsTreeMutation(spec: PlanSpec): boolean {
  // Worktree-isolated tasks never touch the caller's tree, so they need
  // neither the allowTreeMutation declaration nor serialization.
  if (spec.worktree) return false;
  return (spec.tools ?? []).some((tool) => TREE_MUTATING_TOOLS.has(tool));
}

export interface DispatchPlan<T> {
  /** In spec order. */
  refused: Array<{ spec: T; reason: 'profile' | 'mutation'; error: string }>;
  /** Detached read-only runs. */
  background: T[];
  /** The parallel read-only batch. */
  foreground: T[];
  /** Declared tree-mutating tasks, run one at a time after the batch (never backgrounded). */
  mutating: T[];
}

export const MUTATION_REFUSAL = 'refused: edit/write/bash require allowTreeMutation';

export function planDispatch<T extends PlanSpec>(specs: T[], profileFailures: Map<T, string>): DispatchPlan<T> {
  const plan: DispatchPlan<T> = { refused: [], background: [], foreground: [], mutating: [] };
  for (const spec of specs) {
    const profileFailure = profileFailures.get(spec);
    if (profileFailure) {
      plan.refused.push({ spec, reason: 'profile', error: profileFailure });
    } else if (wantsTreeMutation(spec)) {
      if (spec.allowTreeMutation === true) plan.mutating.push(spec);
      else plan.refused.push({ spec, reason: 'mutation', error: MUTATION_REFUSAL });
    } else if (spec.background) {
      plan.background.push(spec);
    } else {
      plan.foreground.push(spec);
    }
  }
  return plan;
}

export interface LastDispatch {
  prompt?: string;
  agentType?: string;
  worktree?: boolean;
}

/** The most recent `subagents:dispatch` custom entry's data, scanning newest first. */
export function findLastDispatch(
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): LastDispatch | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === 'custom' && entry.customType === 'subagents:dispatch') {
      return (entry.data ?? {}) as LastDispatch;
    }
  }
  return undefined;
}
