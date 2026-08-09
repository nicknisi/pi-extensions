/**
 * Tests for the workflow engine, driven by a FAKE SubagentRuntime — no LLM
 * calls, no pi runtime imports. The engine only depends on the
 * SubagentRuntime type, so a hand-rolled fake exercises the full scheduler.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { SpawnOptions, SpawnResult, SpawnUsage, SubagentRuntime } from './subagents.js';
import { runWorkflow, type WorkflowSpec } from './workflow.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function usage(total: number): SpawnUsage {
  return { inputTokens: total, outputTokens: 0, totalTokens: total };
}

type Handler = (opts: SpawnOptions, callIndex: number) => Promise<SpawnResult> | SpawnResult;

interface FakeRuntime extends SubagentRuntime {
  calls: SpawnOptions[];
  maxActive: number;
  /** Set by handlers to flag that a non-tree job overlapped a tree job. */
  treeViolation: boolean;
  treeActive: number;
}

function makeFake(handler: Handler): FakeRuntime {
  let active = 0;
  const fake: FakeRuntime = {
    namespace: 'test',
    calls: [],
    maxActive: 0,
    treeViolation: false,
    treeActive: 0,
    async spawn(opts: SpawnOptions): Promise<SpawnResult> {
      fake.calls.push(opts);
      active++;
      fake.maxActive = Math.max(fake.maxActive, active);
      const isTree = opts.systemPrompt === 'TREE';
      if (isTree) {
        fake.treeActive++;
      } else if (fake.treeActive > 0) {
        fake.treeViolation = true;
      }
      try {
        return await handler(opts, fake.calls.length);
      } finally {
        if (isTree) fake.treeActive--;
        active--;
      }
    },
    spawnDetached(opts: SpawnOptions) {
      return { runId: 'detached', done: this.spawn(opts) };
    },
    listRuns: () => [],
    activeCount: () => active,
  };
  return fake;
}

function ok(text: string, total = 10): SpawnResult {
  return { ok: true, runId: 'r', text, usage: usage(total), durationMs: 1 };
}

function crash(error: string): SpawnResult {
  return { ok: false, runId: 'r', kind: 'crashed', error, text: '', usage: usage(5), durationMs: 1 };
}

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workflow-test-'));
}

/** Real git repo in a tmpdir with one committed file (file.txt = 'hello\n'). */
function initGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workflow-git-'));
  execFileSync('git', ['init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init'],
    { cwd: repo },
  );
  return repo;
}

async function run(
  spec: WorkflowSpec,
  fake: FakeRuntime,
  extra: { runDir?: string; resumeFrom?: string; signal?: AbortSignal } = {},
) {
  return runWorkflow(spec, fake, { cwd: '/tmp', runDir: extra.runDir ?? tmpRunDir(), ...extra });
}

describe('runWorkflow', () => {
  it('runs a linear chain in order and threads results into ctx', async () => {
    const seen: string[] = [];
    const fake = makeFake(async (opts) => {
      seen.push(opts.prompt);
      await sleep(5);
      return ok(`done:${opts.prompt}`);
    });
    const result = await run(
      {
        name: 'chain',
        stages: [
          { id: 'a', prompt: 'first' },
          {
            id: 'b',
            prompt: (ctx) => {
              const a = ctx.results['a'];
              return `second after ${a?.ok ? a.output : '?'}`;
            },
          },
          { id: 'c', prompt: 'third' },
        ],
      },
      fake,
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['first', 'second after done:first', 'third']);
    expect(result.outcomes['c']?.ok).toBe(true);
  });

  it('overlaps independent stages', async () => {
    const fake = makeFake(async () => {
      await sleep(20);
      return ok('x');
    });
    const result = await run(
      {
        name: 'parallel',
        stages: [
          { id: 'a', needs: [], prompt: 'a' },
          { id: 'b', needs: [], prompt: 'b' },
          { id: 'c', needs: [], prompt: 'c' },
        ],
      },
      fake,
    );
    expect(result.ok).toBe(true);
    expect(fake.maxActive).toBeGreaterThan(1);
  });

  it('never runs a sharesTree stage concurrently with anything', async () => {
    const fake = makeFake(async () => {
      await sleep(15);
      return ok('x');
    });
    const result = await run(
      {
        name: 'tree',
        stages: [
          { id: 'a', needs: [], prompt: 'a' },
          { id: 'edit', needs: [], prompt: 'edit', sharesTree: true, systemPrompt: 'TREE' },
          { id: 'b', needs: [], prompt: 'b' },
          { id: 'c', needs: [], prompt: 'c' },
        ],
      },
      fake,
    );
    expect(result.ok).toBe(true);
    expect(fake.treeViolation).toBe(false);
  });

  it('transitively skips dependents of a failed stage', async () => {
    const fake = makeFake((opts) => (opts.prompt === 'explode' ? crash('boom') : ok('fine')));
    const result = await run(
      {
        name: 'skip',
        stages: [
          { id: 'a', needs: [], prompt: 'explode' },
          { id: 'b', needs: ['a'], prompt: 'b' },
          { id: 'c', needs: ['b'], prompt: 'c' },
        ],
      },
      fake,
    );
    expect(result.ok).toBe(false);
    expect(result.outcomes['a']).toMatchObject({ ok: false, kind: 'crashed' });
    expect(result.outcomes['b']).toMatchObject({ ok: false, kind: 'skipped' });
    expect(result.outcomes['c']).toMatchObject({ ok: false, kind: 'skipped' });
    expect(fake.calls).toHaveLength(1);
  });

  it('expands foreach with per-item concurrency and aggregates output', async () => {
    const fake = makeFake(async (opts) => {
      await sleep(10);
      return ok(`out:${opts.prompt}`);
    });
    const result = await run(
      {
        name: 'foreach',
        concurrency: 2,
        stages: [{ id: 'fan', needs: [], foreach: [1, 2, 3, 4], prompt: (_ctx, item) => `item-${item}` }],
      },
      fake,
    );
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(4);
    expect(fake.maxActive).toBe(2);
    const outcome = result.outcomes['fan'];
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(JSON.parse(outcome.output)).toEqual(['out:item-1', 'out:item-2', 'out:item-3', 'out:item-4']);
      expect(outcome.attempts).toBe(4);
    }
  });

  it('resolves foreach items from a dependency outcome via pick', async () => {
    const fake = makeFake((opts) => (opts.prompt === 'produce' ? ok('ignored') : ok(`handled:${opts.prompt}`)));
    const result = await run(
      {
        name: 'foreach-from',
        stages: [
          { id: 'a', needs: [], prompt: 'produce' },
          {
            id: 'b',
            needs: ['a'],
            foreach: { from: 'a', pick: () => ['x', 'y'] },
            prompt: (_ctx, item) => `handle-${item}`,
          },
        ],
      },
      fake,
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.map((c) => c.prompt)).toEqual(['produce', 'handle-x', 'handle-y']);
  });

  it('settles an empty static foreach with an ok empty aggregate', async () => {
    const fake = makeFake(() => ok('unused'));
    const result = await run(
      {
        name: 'foreach-empty',
        stages: [{ id: 'fan', needs: [], foreach: [], prompt: 'never spawned' }],
      },
      fake,
    );
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(0);
    const outcome = result.outcomes['fan'];
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.output).toBe('[]');
      expect(outcome.data).toBeUndefined();
      expect(outcome.attempts).toBe(0);
    }
  });

  it('settles a foreach whose pick yields zero items, with data [] when outputSchema is set', async () => {
    const fake = makeFake(() => ok('produce'));
    const result = await run(
      {
        name: 'foreach-empty-pick',
        stages: [
          { id: 'a', needs: [], prompt: 'produce' },
          {
            id: 'b',
            needs: ['a'],
            foreach: { from: 'a', pick: () => [] },
            prompt: 'never spawned',
            outputSchema: Type.Object({ value: Type.String() }),
          },
          { id: 'c', needs: ['b'], prompt: 'after' },
        ],
      },
      fake,
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.map((c) => c.prompt)).toEqual(['produce', 'after']);
    const outcome = result.outcomes['b'];
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.output).toBe('[]');
      expect(outcome.data).toEqual([]);
    }
  });

  it('revises via gate feedback and passes on a later attempt', async () => {
    let gateCalls = 0;
    const fake = makeFake(() => ok('draft'));
    const result = await run(
      {
        name: 'gate',
        stages: [
          {
            id: 'a',
            needs: [],
            prompt: 'write',
            gate: () => {
              gateCalls++;
              return gateCalls >= 2 ? true : { revise: 'make it better' };
            },
          },
        ],
      },
      fake,
    );
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.prompt).toContain('make it better');
    expect(result.outcomes['a']).toMatchObject({ ok: true, attempts: 2 });
  });

  it('fails as gate_failed when the gate never passes', async () => {
    const fake = makeFake(() => ok('draft'));
    const result = await run(
      {
        name: 'gate-fail',
        stages: [{ id: 'a', needs: [], prompt: 'write', gate: () => ({ revise: 'again' }), maxGateAttempts: 3 }],
      },
      fake,
    );
    expect(result.ok).toBe(false);
    expect(result.outcomes['a']).toMatchObject({ ok: false, kind: 'gate_failed', attempts: 3 });
    expect(fake.calls).toHaveLength(3);
  });

  it('fails as gate_failed when the gate throws', async () => {
    const fake = makeFake(() => ok('draft'));
    const result = await run(
      {
        name: 'gate-throw',
        stages: [
          {
            id: 'a',
            needs: [],
            prompt: 'write',
            gate: () => {
              throw new Error('gate exploded');
            },
          },
        ],
      },
      fake,
    );
    expect(result.outcomes['a']).toMatchObject({ ok: false, kind: 'gate_failed' });
    const oa = result.outcomes['a'];
    if (oa && !oa.ok) expect(oa.error).toContain('gate exploded');
    expect(oa?.ok).toBe(false);
  });

  it('retries crashed spawns but not aborted ones', async () => {
    let n = 0;
    const fake = makeFake((opts) => {
      if (opts.prompt === 'flaky') {
        n++;
        return n < 3 ? crash('transient') : ok('recovered');
      }
      return {
        ok: false as const,
        runId: 'r',
        kind: 'aborted' as const,
        error: 'stop',
        text: '',
        usage: usage(5),
        durationMs: 1,
      };
    });
    const result = await run(
      {
        name: 'retries',
        stages: [
          { id: 'a', needs: [], prompt: 'flaky', retries: 3 },
          { id: 'b', needs: [], prompt: 'abort-me', retries: 3 },
        ],
      },
      fake,
    );
    expect(result.outcomes['a']).toMatchObject({ ok: true, attempts: 3 });
    expect(result.outcomes['b']).toMatchObject({ ok: false, kind: 'aborted', attempts: 1 });
  });

  it('stops scheduling once the token budget is exceeded', async () => {
    const fake = makeFake(() => ok('x', 1000));
    const result = await run(
      {
        name: 'budget',
        tokenBudget: 500,
        stages: [
          { id: 'a', needs: [], prompt: 'a' },
          { id: 'b', needs: ['a'], prompt: 'b' },
        ],
      },
      fake,
    );
    expect(result.ok).toBe(false);
    expect(result.outcomes['a']?.ok).toBe(true);
    expect(result.outcomes['b']).toMatchObject({ ok: false, kind: 'budget_exceeded' });
    expect(fake.calls).toHaveLength(1);
  });

  it('captures a bounded git diff for sharesTree stages and hands it to dependents', async () => {
    const repo = initGitRepo();
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\nworld\n');

    let dependentSawDiff = '';
    const fake = makeFake(() => ok('x'));
    const result = await runWorkflow(
      {
        name: 'tree-diff',
        stages: [
          { id: 'edit', needs: [], prompt: 'edit', sharesTree: true },
          {
            id: 'review',
            needs: ['edit'],
            prompt: (ctx) => {
              dependentSawDiff = ctx.treeDiffs['edit'] ?? '';
              return 'review';
            },
          },
        ],
      },
      fake,
      { cwd: repo, runDir: tmpRunDir() },
    );
    expect(result.ok).toBe(true);
    expect(dependentSawDiff).toContain('+world');
  });

  it('includes untracked files in the sharesTree handoff', async () => {
    const repo = initGitRepo();
    let dependentSawDiff = '';
    const fake = makeFake((opts) => {
      if (opts.prompt === 'edit') {
        // The stage creates a brand-new file that `git diff HEAD` would miss.
        fs.writeFileSync(path.join(repo, 'new-file.txt'), 'brand new\n');
      }
      return ok('x');
    });
    const result = await runWorkflow(
      {
        name: 'tree-untracked',
        stages: [
          { id: 'edit', needs: [], prompt: 'edit', sharesTree: true },
          {
            id: 'review',
            needs: ['edit'],
            prompt: (ctx) => {
              dependentSawDiff = ctx.treeDiffs['edit'] ?? '';
              return 'review';
            },
          },
        ],
      },
      fake,
      { cwd: repo, runDir: tmpRunDir() },
    );
    expect(result.ok).toBe(true);
    expect(dependentSawDiff).toContain('Untracked files');
    expect(dependentSawDiff).toContain('new-file.txt');
  });

  it('marks the sharesTree handoff explicitly when the diff is truncated at 64KB', async () => {
    const repo = initGitRepo();
    // ~128KB of added lines — comfortably over the 64KB cap.
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\n' + 'x'.repeat(60).concat('\n').repeat(2200));
    let dependentSawDiff = '';
    const fake = makeFake(() => ok('x'));
    const result = await runWorkflow(
      {
        name: 'tree-truncated',
        stages: [
          { id: 'edit', needs: [], prompt: 'edit', sharesTree: true },
          {
            id: 'review',
            needs: ['edit'],
            prompt: (ctx) => {
              dependentSawDiff = ctx.treeDiffs['edit'] ?? '';
              return 'review';
            },
          },
        ],
      },
      fake,
      { cwd: repo, runDir: tmpRunDir() },
    );
    expect(result.ok).toBe(true);
    expect(dependentSawDiff).toContain('…[diff truncated at 64KB]');
  });

  it('writes control artifacts and resumes by skipping previously-ok stages', async () => {
    const runDir = tmpRunDir();
    const first = makeFake((opts) => (opts.prompt === 'fail-first' ? crash('boom') : ok('good')));
    const r1 = await run(
      {
        name: 'resumable',
        stages: [
          { id: 'a', needs: [], prompt: 'fine' },
          { id: 'b', needs: ['a'], prompt: 'fail-first' },
        ],
      },
      first,
      { runDir },
    );
    expect(r1.ok).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'status.json'))).toBe(true);
    const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
    expect(status.specHash).toMatch(/^[0-9a-f]{64}$/);
    const stageArtifact = JSON.parse(fs.readFileSync(path.join(runDir, 'stages', 'a.json'), 'utf8'));
    expect(stageArtifact.outcome.ok).toBe(true);

    const second = makeFake(() => ok('now it works'));
    const r2 = await run(
      {
        name: 'resumable',
        stages: [
          { id: 'a', needs: [], prompt: 'fine' },
          { id: 'b', needs: ['a'], prompt: 'fail-first' },
        ],
      },
      second,
      { runDir: tmpRunDir(), resumeFrom: runDir },
    );
    expect(r2.ok).toBe(true);
    expect(second.calls.map((c) => c.prompt)).toEqual(['fail-first']);
    expect(r2.outcomes['a']?.ok).toBe(true);
  });

  it('re-runs changed stages on resume instead of refusing (content-addressed)', async () => {
    const runDir = tmpRunDir();
    const first = makeFake(() => ok('good'));
    const r1 = await run(
      {
        name: 'spec-drift',
        stages: [{ id: 'a', needs: [], prompt: 'original prompt' }],
      },
      first,
      { runDir },
    );
    expect(r1.ok).toBe(true);

    const second = makeFake(() => ok('reran'));
    const r2 = await run(
      {
        name: 'spec-drift',
        stages: [{ id: 'a', needs: [], prompt: 'changed prompt' }],
      },
      second,
      { runDir: tmpRunDir(), resumeFrom: runDir },
    );
    expect(r2.ok).toBe(true);
    expect(second.calls.map((c) => c.prompt)).toEqual(['changed prompt']);
    expect(r2.outcomes['a']?.ok && r2.outcomes['a']?.output).toBe('reran');
  });

  it('re-runs a stage whose agent changed on resume (agent is part of the content key)', async () => {
    const runDir = tmpRunDir();
    const first = makeFake(() => ok('reviewed'));
    const r1 = await run(
      {
        name: 'agent-drift',
        stages: [{ id: 'a', needs: [], prompt: 'same prompt', agent: 'reviewer' }],
      },
      first,
      { runDir },
    );
    expect(r1.ok).toBe(true);

    const second = makeFake(() => ok('coded'));
    const r2 = await run(
      {
        name: 'agent-drift',
        stages: [{ id: 'a', needs: [], prompt: 'same prompt', agent: 'coder' }],
      },
      second,
      { runDir: tmpRunDir(), resumeFrom: runDir },
    );
    expect(r2.ok).toBe(true);
    expect(second.calls.map((c) => c.prompt)).toEqual(['same prompt']);
    expect(r2.outcomes['a']?.ok && r2.outcomes['a']?.output).toBe('coded');
  });

  it('forward-referenced needs chain the real upstream key (no <unresolved> poison)', async () => {
    const runDir = tmpRunDir();
    // 'a' is declared FIRST but depends on 'b', declared second — the key
    // chain must resolve b's key before hashing a.
    const spec = (bPrompt: string) => ({
      name: 'forward-needs',
      stages: [
        { id: 'a', needs: ['b'], prompt: 'a prompt' },
        { id: 'b', needs: [], prompt: bPrompt },
      ],
    });
    const first = makeFake(() => ok('v1'));
    const r1 = await run(spec('b prompt v1'), first, { runDir });
    expect(r1.ok).toBe(true);

    // Changing the FORWARD-referenced upstream must invalidate the dependent.
    const second = makeFake(() => ok('v2'));
    const r2 = await run(spec('b prompt v2'), second, {
      runDir: tmpRunDir(),
      resumeFrom: runDir,
    });
    expect(r2.ok).toBe(true);
    // Both stages re-ran: b changed, and a's key changed via the upstream chain.
    expect(second.calls).toHaveLength(2);
  });

  it('replays an unchanged spec on resume with ZERO stage executions', async () => {
    const runDir = tmpRunDir();
    const first = makeFake(() => ok('good'));
    const r1 = await run(
      {
        name: 'replay-all',
        stages: [
          { id: 'a', needs: [], prompt: 'a' },
          { id: 'b', needs: ['a'], prompt: 'b' },
          { id: 'c', needs: ['b'], prompt: 'c' },
        ],
      },
      first,
      { runDir },
    );
    expect(r1.ok).toBe(true);
    expect(first.calls).toHaveLength(3);

    const events: { type: string; replayed?: number; rerun?: number }[] = [];
    const second = makeFake(() => ok('should-not-run'));
    const r2 = await runWorkflow(
      {
        name: 'replay-all',
        stages: [
          { id: 'a', needs: [], prompt: 'a' },
          { id: 'b', needs: ['a'], prompt: 'b' },
          { id: 'c', needs: ['b'], prompt: 'c' },
        ],
      },
      second,
      { cwd: '/tmp', runDir: tmpRunDir(), resumeFrom: runDir, onProgress: (e) => events.push(e) },
    );
    expect(r2.ok).toBe(true);
    expect(second.calls).toHaveLength(0);
    const summary = events.find((e) => e.type === 'resume_summary');
    expect(summary?.replayed).toBe(3);
    expect(summary?.rerun).toBe(0);
  });

  it('re-runs a changed stage and its transitive dependents, replaying unrelated branches', async () => {
    const runDir = tmpRunDir();
    const first = makeFake(() => ok('good'));
    const r1 = await run(
      {
        name: 'partial-replay',
        stages: [
          { id: 'root-a', needs: [], prompt: 'ra' },
          { id: 'branch-a1', needs: ['root-a'], prompt: 'a1' },
          { id: 'branch-a2', needs: ['branch-a1'], prompt: 'a2' },
          { id: 'root-b', needs: [], prompt: 'rb' },
          { id: 'branch-b1', needs: ['root-b'], prompt: 'b1' },
        ],
      },
      first,
      { runDir },
    );
    expect(r1.ok).toBe(true);

    // Edit only branch-a1's prompt. branch-a2 depends on it transitively, so
    // both must re-run. root-a, root-b, branch-b1 are untouched → replayed.
    const second = makeFake((opts) => ok(`reran:${opts.prompt}`));
    const r2 = await run(
      {
        name: 'partial-replay',
        stages: [
          { id: 'root-a', needs: [], prompt: 'ra' },
          { id: 'branch-a1', needs: ['root-a'], prompt: 'a1 CHANGED' },
          { id: 'branch-a2', needs: ['branch-a1'], prompt: 'a2' },
          { id: 'root-b', needs: [], prompt: 'rb' },
          { id: 'branch-b1', needs: ['root-b'], prompt: 'b1' },
        ],
      },
      second,
      { runDir: tmpRunDir(), resumeFrom: runDir },
    );
    expect(r2.ok).toBe(true);
    expect(second.calls.map((c) => c.prompt).sort()).toEqual(['a1 CHANGED', 'a2'].sort());
    expect(r2.outcomes['root-a']?.ok && r2.outcomes['root-a']?.output).toBe('good');
    expect(r2.outcomes['root-b']?.ok && r2.outcomes['root-b']?.output).toBe('good');
    expect(r2.outcomes['branch-b1']?.ok && r2.outcomes['branch-b1']?.output).toBe('good');
    expect(r2.outcomes['branch-a1']?.ok && r2.outcomes['branch-a1']?.output).toBe('reran:a1 CHANGED');
    expect(r2.outcomes['branch-a2']?.ok && r2.outcomes['branch-a2']?.output).toBe('reran:a2');
  });

  it('editing a function-valued prompt body changes its stage key (closes the <function> gap)', async () => {
    const runDir = tmpRunDir();
    const first = makeFake(() => ok('good'));
    const r1 = await run(
      {
        name: 'fn-prompt',
        stages: [{ id: 'a', needs: [], prompt: () => 'build it' }],
      },
      first,
      { runDir },
    );
    expect(r1.ok).toBe(true);

    // Same observable return value, different closure body text → key must
    // differ, so the stage re-runs instead of being silently replayed. (A
    // body like `'build' + ' it'` would be constant-folded back to the same
    // source by the TS transform, so use a structurally distinct body.)
    const second = makeFake(() => ok('reran'));
    const r2 = await run(
      {
        name: 'fn-prompt',
        stages: [
          {
            id: 'a',
            needs: [],
            prompt: (_ctx) => {
              return 'build it';
            },
          },
        ],
      },
      second,
      { runDir: tmpRunDir(), resumeFrom: runDir },
    );
    expect(r2.ok).toBe(true);
    expect(second.calls).toHaveLength(1);
    expect(r2.outcomes['a']?.ok && r2.outcomes['a']?.output).toBe('reran');
  });

  it('back-compat: a prior runDir without stageKeys resumes when specHash matches', async () => {
    const runDir = tmpRunDir();
    const first = makeFake(() => ok('good'));
    const r1 = await run(
      {
        name: 'old-format',
        stages: [
          { id: 'a', needs: [], prompt: 'a' },
          { id: 'b', needs: ['a'], prompt: 'b' },
        ],
      },
      first,
      { runDir },
    );
    expect(r1.ok).toBe(true);

    // Strip the per-stage keys to simulate an old-format runDir.
    const statusPath = path.join(runDir, 'status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    delete status.stageKeys;
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));

    const second = makeFake(() => ok('should-not-run'));
    const r2 = await run(
      {
        name: 'old-format',
        stages: [
          { id: 'a', needs: [], prompt: 'a' },
          { id: 'b', needs: ['a'], prompt: 'b' },
        ],
      },
      second,
      { runDir: tmpRunDir(), resumeFrom: runDir },
    );
    expect(r2.ok).toBe(true);
    expect(second.calls).toHaveLength(0);
  });

  it('back-compat: a prior runDir without stageKeys runs fresh (no crash) when specHash differs', async () => {
    const runDir = tmpRunDir();
    const first = makeFake(() => ok('good'));
    const r1 = await run(
      {
        name: 'old-format-drift',
        stages: [{ id: 'a', needs: [], prompt: 'original' }],
      },
      first,
      { runDir },
    );
    expect(r1.ok).toBe(true);

    const statusPath = path.join(runDir, 'status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    delete status.stageKeys;
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));

    const second = makeFake(() => ok('reran'));
    const r2 = await run(
      {
        name: 'old-format-drift',
        stages: [{ id: 'a', needs: [], prompt: 'changed' }],
      },
      second,
      { runDir: tmpRunDir(), resumeFrom: runDir },
    );
    expect(r2.ok).toBe(true);
    expect(second.calls).toHaveLength(1);
  });

  it('threads opts.signal into every stage spawn', async () => {
    const fake = makeFake(() => ok('done'));
    const controller = new AbortController();
    await run(
      {
        name: 'signal',
        stages: [
          { id: 'a', needs: [], prompt: 'A' },
          { id: 'b', needs: ['a'], prompt: 'B', foreach: [1, 2] },
        ],
      },
      fake,
      { signal: controller.signal },
    );
    expect(fake.calls.length).toBe(3);
    for (const call of fake.calls) expect(call.signal).toBe(controller.signal);
  });
});
