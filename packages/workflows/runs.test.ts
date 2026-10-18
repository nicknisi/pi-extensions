import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReplay, type EngineSpawnFn, type EngineSpawnResult } from './engine.js';
import { formatRunResult, readJournal, readStoredRun, startRun, sweepWorkflowRuns, type WorkflowRuns } from './runs.js';

const roots: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wf-runs-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const ok = (text: string): EngineSpawnResult => ({ ok: true, text, usage });

/** Records prompts; `fail` prompts fail, `hang` prompts wait for their abort signal. */
function recordingSpawn(prompts: string[], fail: Set<string> = new Set()): EngineSpawnFn {
  return async (opts) => {
    prompts.push(opts.prompt);
    if (opts.prompt.startsWith('hang')) {
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: false, kind: 'aborted', error: 'Aborted by caller', text: '', usage };
    }
    if (fail.has(opts.prompt)) return { ok: false, kind: 'crashed', error: 'boom', text: '', usage };
    return ok(`did ${opts.prompt}`);
  };
}

const SCRIPT = `export const meta = { name: 'demo', description: 'demo run' };
phase('Find');
const found = await agent('list files');
phase('Audit');
const audits = await parallel(['a', 'b', 'c'].map((f) => () => agent('audit ' + f)));
return { found, audits };`;

describe('createReplay', () => {
  it('replays a matching prefix and re-runs from the first mismatch onward', () => {
    const prior = [0, 1, 2].map((seq) => ({ seq, key: `k${seq}`, result: ok(`r${seq}`) }));
    const replay = createReplay(prior);
    expect(replay.take(0, 'k0')).toMatchObject({ text: 'r0' });
    expect(replay.take(1, 'changed')).toBeUndefined();
    expect(replay.take(2, 'k2')).toBeUndefined(); // after a divergence everything re-runs
  });

  it('re-runs a failed agent and everything after it', () => {
    const failed: EngineSpawnResult = { ok: false, kind: 'crashed', error: 'x', text: '', usage };
    const replay = createReplay([
      { seq: 0, key: 'k0', result: failed },
      { seq: 1, key: 'k1', result: ok('r1') },
    ]);
    expect(replay.take(0, 'k0')).toBeUndefined();
    expect(replay.take(1, 'k1')).toBeUndefined();
  });
});

describe('startRun', () => {
  it('runs in the background, tracks phases and agents, and persists run + journal', async () => {
    const root = tmpRoot();
    const runs: WorkflowRuns = new Map();
    const prompts: string[] = [];
    const run = startRun(runs, {
      root,
      script: SCRIPT,
      args: { x: 1 },
      label: 'demo',
      cwd: '/tmp',
      spawn: () => recordingSpawn(prompts),
    });
    expect(run.status).toBe('running');
    expect(runs.get(run.id)).toBe(run);
    await run.done;
    expect(run.status).toBe('completed');
    expect(run.phases).toEqual(['Find', 'Audit']);
    expect(run.agents.map((a) => [a.seq, a.phase, a.status])).toEqual([
      [0, 'Find', 'done'],
      [1, 'Audit', 'done'],
      [2, 'Audit', 'done'],
      [3, 'Audit', 'done'],
    ]);
    expect(formatRunResult(run)).toContain('did audit b');
    expect(readStoredRun(root, run.id)).toMatchObject({ label: 'demo', args: { x: 1 }, status: 'completed' });
    expect(readJournal(run.dir)).toHaveLength(4);
  });

  it('relaunch replays completed agents and re-runs only failed ones and those after them', async () => {
    const root = tmpRoot();
    const runs: WorkflowRuns = new Map();
    const first: string[] = [];
    const run = startRun(runs, {
      root,
      script: SCRIPT,
      args: undefined,
      label: 'demo',
      cwd: '/tmp',
      spawn: () => recordingSpawn(first, new Set(['audit b'])),
    });
    await run.done;
    expect(run.agents.find((a) => a.prompt === 'audit b')?.status).toBe('failed');

    const second: string[] = [];
    const again = startRun(runs, {
      root,
      script: SCRIPT,
      args: undefined,
      label: 'demo',
      cwd: '/tmp',
      relaunch: run.id,
      spawn: () => recordingSpawn(second),
    });
    await again.done;
    expect(again.id).toBe(run.id);
    expect(second).toEqual(['audit b', 'audit c']);
    expect(again.agents.map((a) => a.status)).toEqual(['cached', 'cached', 'done', 'done']);
    // The rewritten journal is complete, so another relaunch replays everything.
    const third: string[] = [];
    await startRun(runs, {
      root,
      script: SCRIPT,
      args: undefined,
      label: 'demo',
      cwd: '/tmp',
      relaunch: run.id,
      spawn: () => recordingSpawn(third),
    }).done;
    expect(third).toEqual([]);
  });

  it('stop aborts in-flight agents and marks the run stopped', async () => {
    const runs: WorkflowRuns = new Map();
    const run = startRun(runs, {
      root: tmpRoot(),
      script: `return await parallel([() => agent('hang 1'), () => agent('hang 2')]);`,
      args: undefined,
      label: 'inline',
      cwd: '/tmp',
      spawn: (runSignal) => async (opts) =>
        recordingSpawn([])({ ...opts, signal: AbortSignal.any([runSignal, opts.signal!]) }),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(run.agents.map((a) => a.status)).toEqual(['running', 'running']);
    run.controller.abort();
    await run.done;
    expect(run.status).toBe('stopped');
    expect(run.agents.every((a) => a.status === 'failed')).toBe(true);
  });

  it('stopping one agent fails just that agent (null in the wave)', async () => {
    const runs: WorkflowRuns = new Map();
    const run = startRun(runs, {
      root: tmpRoot(),
      script: `return await parallel([() => agent('hang 1'), () => agent('quick')]);`,
      args: undefined,
      label: 'inline',
      cwd: '/tmp',
      spawn: () => recordingSpawn([]),
    });
    await new Promise((r) => setTimeout(r, 10));
    run.agents[0]!.stop();
    await run.done;
    expect(run.status).toBe('completed');
    expect(run.summary).toContain('null');
    expect(run.summary).toContain('did quick');
  });

  it('restart re-runs one agent from the same prompt', async () => {
    const runs: WorkflowRuns = new Map();
    let calls = 0;
    const run = startRun(runs, {
      root: tmpRoot(),
      script: `return await agent('hang then finish');`,
      args: undefined,
      label: 'inline',
      cwd: '/tmp',
      spawn: () => async (opts) => (++calls === 1 ? recordingSpawn([])(opts) : ok('second attempt')),
    });
    await new Promise((r) => setTimeout(r, 10));
    run.agents[0]!.restart();
    await run.done;
    expect(run.summary).toBe('second attempt');
    expect(run.agents[0]!.attempts).toBe(2);
  });
});

describe('sweepWorkflowRuns', () => {
  it('deletes only old workflow run dirs', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'wf-00000001'));
    fs.mkdirSync(path.join(root, 'wf-00000002'));
    fs.mkdirSync(path.join(root, 'keep-me'));
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(root, 'wf-00000001'), old, old);
    fs.utimesSync(path.join(root, 'keep-me'), old, old);
    sweepWorkflowRuns(root, 5_000);
    expect(fs.readdirSync(root).sort()).toEqual(['keep-me', 'wf-00000002']);
  });
});

describe('relaunch and stop edge cases', () => {
  it('a relaunch that fails before replaying keeps the saved journal', async () => {
    const root = tmpRoot();
    const runs: WorkflowRuns = new Map();
    const run = startRun(runs, {
      root,
      script: SCRIPT,
      args: undefined,
      label: 'demo',
      cwd: '/tmp',
      spawn: () => recordingSpawn([]),
    });
    await run.done;
    const broken = startRun(runs, {
      root,
      script: 'this is not javascript (',
      args: undefined,
      label: 'demo',
      cwd: '/tmp',
      relaunch: run.id,
      spawn: () => recordingSpawn([]),
    });
    await broken.done;
    expect(broken.status).toBe('failed');
    expect(readJournal(run.dir)).toHaveLength(4);
  });

  it('a stopped run neither spawns queued agents nor writes late journal lines', async () => {
    const root = tmpRoot();
    const runs: WorkflowRuns = new Map();
    const prompts: string[] = [];
    const run = startRun(runs, {
      root,
      script: `try { await agent('hang first'); } catch {} return await agent('never');`,
      args: undefined,
      label: 'inline',
      cwd: '/tmp',
      spawn: (runSignal) => async (opts) =>
        recordingSpawn(prompts)({ ...opts, signal: AbortSignal.any([runSignal, opts.signal!]) }),
    });
    await new Promise((r) => setTimeout(r, 10));
    run.controller.abort();
    await run.done;
    const atStop = readJournal(run.dir);
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toEqual(['hang first']);
    expect(readJournal(run.dir)).toEqual(atStop);
    expect(atStop.every((e) => !e.result.ok)).toBe(true);
  });

  it('manual restarts never count toward the stall-restart limit', async () => {
    const runs: WorkflowRuns = new Map();
    let calls = 0;
    const run = startRun(runs, {
      root: tmpRoot(),
      script: `return await agent('hang until restarted');`,
      args: undefined,
      label: 'inline',
      cwd: '/tmp',
      spawn: () => async (opts) => (++calls <= 7 ? recordingSpawn([])(opts) : ok('finally')),
    });
    for (let i = 0; i < 7; i++) {
      await new Promise((r) => setTimeout(r, 5));
      run.agents[0]!.restart();
    }
    await run.done;
    expect(run.summary).toBe('finally');
    expect(run.agents[0]!.attempts).toBe(8);
  });
});
