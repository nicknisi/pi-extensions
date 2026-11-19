import { describe, expect, it } from 'vitest';
import { findLastDispatch, MUTATION_REFUSAL, planDispatch, wantsTreeMutation } from './dispatch-plan.js';

type Spec = { task: string; tools?: string[]; worktree?: boolean; allowTreeMutation?: boolean; background?: boolean };

describe('wantsTreeMutation', () => {
  it('flags edit/write/bash outside a worktree only', () => {
    expect(wantsTreeMutation({ tools: ['read', 'grep'] })).toBe(false);
    expect(wantsTreeMutation({})).toBe(false);
    expect(wantsTreeMutation({ tools: ['bash'] })).toBe(true);
    expect(wantsTreeMutation({ tools: ['edit'], worktree: true })).toBe(false);
  });
});

describe('planDispatch', () => {
  it('partitions refused, background, foreground, and mutating tasks', () => {
    const readOnly: Spec = { task: 'read' };
    const bg: Spec = { task: 'bg', background: true };
    const undeclared: Spec = { task: 'undeclared', tools: ['edit'] };
    const declared: Spec = { task: 'declared', tools: ['write'], allowTreeMutation: true, background: true };
    const worktree: Spec = { task: 'wt', tools: ['edit', 'bash'], worktree: true };
    const badProfile: Spec = { task: 'bad profile', tools: ['edit'], allowTreeMutation: true };
    const plan = planDispatch(
      [readOnly, bg, undeclared, declared, worktree, badProfile],
      new Map([[badProfile, "unknown profile 'x'"]]),
    );
    expect(plan.refused).toEqual([
      { spec: undeclared, reason: 'mutation', error: MUTATION_REFUSAL },
      { spec: badProfile, reason: 'profile', error: "unknown profile 'x'" },
    ]);
    expect(plan.background).toEqual([bg]);
    expect(plan.foreground).toEqual([readOnly, worktree]);
    // A declared mutating task is serialized even when it asked for background.
    expect(plan.mutating).toEqual([declared]);
  });
});

describe('findLastDispatch', () => {
  it('returns the newest subagents:dispatch entry data', () => {
    const entries = [
      { type: 'custom', customType: 'subagents:dispatch', data: { prompt: 'old' } },
      { type: 'message' },
      { type: 'custom', customType: 'other', data: { prompt: 'nope' } },
      { type: 'custom', customType: 'subagents:dispatch', data: { prompt: 'new', agentType: 'scout' } },
      { type: 'message' },
    ];
    expect(findLastDispatch(entries)).toEqual({ prompt: 'new', agentType: 'scout' });
  });

  it('returns undefined when there is none', () => {
    expect(findLastDispatch([{ type: 'message' }])).toBeUndefined();
  });
});
