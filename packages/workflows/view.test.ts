import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineSpawnFn } from './engine.js';
import { startRun, type WorkflowRun, type WorkflowRuns } from './runs.js';
import { phaseGroups, WorkflowsView, type ViewResult } from './view.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as never;
const tui = { terminal: { rows: 40 }, requestRender() {} } as never;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** `hang` prompts wait for their abort; everything else finishes at once. */
const spawn: EngineSpawnFn = async (opts) => {
  if (opts.prompt.startsWith('hang')) {
    await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return { ok: false, kind: 'aborted', error: 'Aborted by caller', text: '', usage };
  }
  return { ok: true, text: `result of ${opts.prompt}`, usage };
};

function demoRun(runs: WorkflowRuns): WorkflowRun {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wf-view-'));
  roots.push(root);
  return startRun(runs, {
    root,
    script: `export const meta = { name: 'demo', description: 'd' };
phase('Find'); await agent('find things', { label: 'finder' });
phase('Audit'); return await parallel([() => agent('audit a', { label: 'a' }), () => agent('hang b', { label: 'b' })]);`,
    args: undefined,
    label: 'demo',
    cwd: '/tmp',
    spawn: () => spawn,
  });
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const screen = (view: WorkflowsView) => view.render(120).join('\n');

describe('WorkflowsView', () => {
  it('opens a single run at its phases, drills to agents and detail, and stops an agent', async () => {
    const runs: WorkflowRuns = new Map();
    const run = demoRun(runs);
    await tick();
    let closed: ViewResult | 'open' = 'open';
    const view = new WorkflowsView(
      () => [...runs.values()],
      undefined,
      tui,
      theme,
      (r) => (closed = r),
      () => {},
    );
    expect(phaseGroups(run)).toEqual(['Find', 'Audit']);
    expect(screen(view)).toContain('Find 1/1 done');
    expect(screen(view)).toContain('Audit 1/2 done · 1 running');

    view.handleInput('\x1b[B'); // down → Audit
    view.handleInput('\r'); // agents
    expect(screen(view)).toContain('a done');
    view.handleInput('f'); // filter: running
    expect(screen(view)).toContain('showing running');
    expect(screen(view)).toContain('b running');
    view.handleInput('\r'); // detail of b
    expect(screen(view)).toContain('hang b');
    view.handleInput('x'); // stop b
    await run.done;
    expect(run.status).toBe('completed');
    expect(run.agents.find((a) => a.label === 'b')?.status).toBe('failed');

    view.handleInput('\x1b'); // back to agents
    view.handleInput('\x1b'); // back to phases
    view.handleInput('s'); // save
    expect(closed).toEqual({ save: run.id });
  });

  it('lists several runs first and toggles pause on the selected run', async () => {
    const runs: WorkflowRuns = new Map();
    const first = demoRun(runs);
    const second = demoRun(runs);
    await tick();
    const view = new WorkflowsView(
      () => [...runs.values()],
      undefined,
      tui,
      theme,
      () => {},
      () => {},
    );
    expect(screen(view)).toContain('2 runs');
    view.handleInput('p');
    expect(first.gate.paused).toBe(true);
    view.handleInput('p');
    expect(first.gate.paused).toBe(false);
    view.handleInput('\x1b[B');
    view.handleInput('x'); // stop the second run
    await second.done;
    expect(second.status).toBe('stopped');
    first.controller.abort();
    await first.done;
    view.handleInput('\x1b'); // Esc at the top closes and stops the redraw timer
  });
});
