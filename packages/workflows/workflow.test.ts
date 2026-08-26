/**
 * Tests for the workflow engine (pi-free) and saved-workflow discovery.
 *
 * Style follows packages/shared/subagents.test.ts: a fake spawn with no real
 * child sessions, and tmp dirs for filesystem discovery. The vm/parallel/
 * pipeline/args/budget coverage exercises engine.ts directly; discovery
 * coverage imports listWorkflows/findWorkflowFile from index.ts and points
 * PI_CODING_AGENT_DIR at a tmp dir so getAgentDir() resolves there.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunGate, runScript, type EngineSpawnFn, type EngineSpawnResult } from './engine.js';

const tmpdirs: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workflows-test-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Fake spawn ─────────────────────────────────────────────────────────────
// Echoes the prompt as text; carries a fixed token cost so budget accounting
// is observable. An `impl` override lets individual cases craft outcomes.

function fakeSpawn(impl?: (opts: { prompt: string }) => EngineSpawnResult): EngineSpawnFn {
  return async (opts) =>
    impl
      ? impl(opts)
      : {
          ok: true,
          text: `echo: ${opts.prompt}`,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
}

function fakeFail(kind: string, error: string): EngineSpawnFn {
  return async () => ({
    ok: false,
    kind,
    error,
    text: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
}

describe('engine: meta export + vm compile', () => {
  it('strips `export const meta =` and surfaces meta.name/description', async () => {
    const r = await runScript({
      script: "export const meta = { name: 'demo', description: 'a demo' };\nreturn meta.name;",
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.meta?.name).toBe('demo');
    expect(r.meta?.description).toBe('a demo');
    expect(r.value).toBe('demo');
  });

  it('compiles a top-level return (wrapped in an async function)', async () => {
    const r = await runScript({
      script: 'const x = 21; return x * 2;',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toBe(42);
    expect(r.meta).toBeUndefined();
  });

  it('returns undefined when the script forgets to return', async () => {
    const r = await runScript({
      script: 'const x = 1;',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toBeUndefined();
  });

  it('multi-line meta object is captured whole', async () => {
    const r = await runScript({
      script: [
        'export const meta = {',
        "  name: 'lanes',",
        "  description: 'parallel lanes',",
        '  phases: [{ title: "Execute" }],',
        '};',
        'return meta.phases.length;',
      ].join('\n'),
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.meta?.name).toBe('lanes');
    expect(r.meta?.phases).toEqual([{ title: 'Execute' }]);
    expect(r.value).toBe(1);
  });
});

describe('engine: parallel + pipeline', () => {
  it('parallel awaits Promise.all over zero-arg thunks', async () => {
    const r = await runScript({
      script: 'const r = await parallel([() => agent("a"), () => agent("b")]); return r;',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toEqual(['echo: a', 'echo: b']);
  });

  it('pipeline folds items through stages in parallel waves', async () => {
    const r = await runScript({
      script: 'const out = await pipeline([1, 2], async (n) => n * 2, async (n) => n + 1); return out;',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toEqual([3, 5]);
  });

  it('pipeline with zero items returns an empty array (no stranded stage)', async () => {
    const r = await runScript({
      script: 'const out = await pipeline([], async (n) => n); return out;',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toEqual([]);
  });
});

describe('engine: args + budget + log/phase', () => {
  it('passes args through as a global', async () => {
    const r = await runScript({
      script: 'return args.projectName;',
      args: { projectName: 'foo', phases: [] },
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toBe('foo');
  });

  it('budget.spent accumulates over agent() calls', async () => {
    const r = await runScript({
      script: 'await agent("x"); await agent("y"); return budget.spent;',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toBe(30);
    expect(r.usage.totalTokens).toBe(30);
    expect(r.usage.inputTokens).toBe(20);
  });

  it('budget.total defaults to Infinity and remaining tracks spent', async () => {
    const r = await runScript({
      script: 'await agent("x"); return { total: budget.total, remaining: budget.remaining };',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toEqual({ total: Infinity, remaining: Infinity });
  });

  it('budget.total honors a configured cap', async () => {
    const r = await runScript({
      script: 'return { total: budget.total, remaining: budget.remaining };',
      spawn: fakeSpawn(),
      cwd: '/tmp',
      budgetTotal: 1000,
    });
    expect(r.value).toEqual({ total: 1000, remaining: 1000 });
  });

  it('log and phase capture into the result logs', async () => {
    const r = await runScript({
      script: 'phase("Wave 1"); log("hello", { k: 1 }); return "done";',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.logs).toContain('── Wave 1');
    expect(r.logs.some((l) => l.startsWith('hello'))).toBe(true);
  });
});

describe('engine: agent opts + failures', () => {
  it('agentType is accepted but ignored (logged), no registry', async () => {
    const r = await runScript({
      script: "await agent('x', { agentType: 'scout' }); return 'ok';",
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toBe('ok');
    expect(r.logs.some((l) => l.includes("agentType 'scout'"))).toBe(true);
  });

  it('label maps to the spawn agent label', async () => {
    let seen: string | undefined;
    const spawn: EngineSpawnFn = async (opts) => {
      seen = opts.agent;
      return { ok: true, text: 'ok', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    };
    await runScript({
      script: "await agent('x', { label: 'reviewer' }); return 'ok';",
      spawn,
      cwd: '/tmp',
    });
    expect(seen).toBe('reviewer');
  });

  it('defaults children to read-only tools when tools omitted', async () => {
    let seen: string[] | undefined;
    const spawn: EngineSpawnFn = async (opts) => {
      seen = opts.tools;
      return { ok: true, text: 'ok', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    };
    await runScript({
      script: "await agent('x'); return 'ok';",
      spawn,
      cwd: '/tmp',
    });
    expect(seen).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('agent failure throws `${kind}: ${error}`', async () => {
    const r = await runScript({
      script: 'try { await agent("x"); } catch (e) { return e.message; }',
      spawn: fakeFail('crashed', 'boom'),
      cwd: '/tmp',
    });
    expect(r.value).toBe('crashed: boom');
  });

  it('agent returns res.data when a schema/data payload is present', async () => {
    const spawn: EngineSpawnFn = async () => ({
      ok: true,
      text: '{"verdict":"PASS"}',
      data: { verdict: 'PASS' },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    const r = await runScript({
      script: 'const v = await agent("x"); return v.verdict;',
      spawn,
      cwd: '/tmp',
    });
    expect(r.value).toBe('PASS');
  });
});

describe('engine: gate (pause/resume)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it('a paused gate holds agent() before the spawn until resumed', async () => {
    const gate = createRunGate();
    let spawns = 0;
    const spawn: EngineSpawnFn = async () => {
      spawns++;
      return { ok: true, text: 'ok', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    };
    gate.pause();
    const run = runScript({ script: 'await agent("x"); return "done";', spawn, cwd: '/tmp', gate });
    await tick();
    expect(spawns).toBe(0); // held at the gate, spawn never fired
    gate.resume();
    const r = await run;
    expect(spawns).toBe(1);
    expect(r.value).toBe('done');
  });

  it('abort() rejects a parked run instead of hanging it', async () => {
    const gate = createRunGate();
    gate.pause();
    const run = runScript({ script: 'await agent("x"); return "done";', spawn: fakeSpawn(), cwd: '/tmp', gate });
    gate.abort();
    await expect(run).rejects.toThrow('aborted');
  });

  it('abort() rejects future waits too (no re-arm after stop)', async () => {
    const gate = createRunGate();
    gate.abort();
    await expect(gate.wait()).rejects.toThrow('aborted');
  });
});

describe('engine: checkpoint + ask', () => {
  it('checkpoint without a host is a logged no-op', async () => {
    const r = await runScript({
      script: 'await checkpoint("review"); return "ok";',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toBe('ok');
    expect(r.logs.some((l) => l.includes("checkpoint 'review' skipped"))).toBe(true);
  });

  it('checkpoint with a host is invoked with its label and gates the run', async () => {
    const calls: Array<string | undefined> = [];
    const r = await runScript({
      script: 'await checkpoint(); await checkpoint("ship?"); return "ok";',
      spawn: fakeSpawn(),
      cwd: '/tmp',
      checkpoint: async (label) => {
        calls.push(label);
      },
    });
    expect(r.value).toBe('ok');
    expect(calls).toEqual([undefined, 'ship?']);
  });

  it('a throwing checkpoint host stops the run (rejected gate = stop)', async () => {
    await expect(
      runScript({
        script: 'await checkpoint("review"); return "unreachable";',
        spawn: fakeSpawn(),
        cwd: '/tmp',
        checkpoint: async () => {
          throw new Error('rejected');
        },
      }),
    ).rejects.toThrow('rejected');
  });

  it('ask without a host throws (never invent an answer)', async () => {
    const r = await runScript({
      script: 'try { await ask("continue?"); } catch (e) { return e.message; }',
      spawn: fakeSpawn(),
      cwd: '/tmp',
    });
    expect(r.value).toBe('ask() unavailable in this host');
  });

  it('ask passes question + options to the host and returns the answer', async () => {
    const seen: Array<{ q: string; opts?: string[] }> = [];
    const r = await runScript({
      script: 'const a = await ask("pick", ["a", "b"]); const b = await ask("ok?"); return { a, b };',
      spawn: fakeSpawn(),
      cwd: '/tmp',
      ask: async (q, opts) => {
        seen.push({ q, ...(opts ? { opts } : {}) });
        return opts ? 'b' : true;
      },
    });
    expect(r.value).toEqual({ a: 'b', b: true });
    expect(seen).toEqual([{ q: 'pick', opts: ['a', 'b'] }, { q: 'ok?' }]);
    expect(r.logs.some((l) => l === '? pick')).toBe(true);
  });
});

// ── Saved-workflow discovery ───────────────────────────────────────────────

describe('saved-workflow discovery', () => {
  let prevAgentDir: string | undefined;
  let agentDir: string;
  let projectDir: string;

  beforeEach(() => {
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = tmpRoot();
    projectDir = tmpRoot();
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });
  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  });

  // Imported lazily so PI_CODING_AGENT_DIR is set before getAgentDir() is
  // called. index.ts reads getAgentDir() at call time inside workflowDirs,
  // not at module load, so this resolves to the tmp agentDir.
  async function loadDiscovery() {
    const mod = await import('./index.js');
    return { listWorkflows: mod.listWorkflows, findWorkflowFile: mod.findWorkflowFile };
  }

  it('lists global workflows from ~/.pi/agent/workflows', async () => {
    const { listWorkflows } = await loadDiscovery();
    const dir = path.join(agentDir, 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'research.js'),
      "export const meta = { name: 'research', description: 'parallel research' };\nreturn 'ok';",
    );
    fs.writeFileSync(path.join(dir, 'empty.js'), '// no meta\nreturn 1;');

    const items = listWorkflows(projectDir, false);
    expect(items.map((i) => i.name).sort()).toEqual(['empty', 'research']);
    const research = items.find((i) => i.name === 'research')!;
    expect(research.scope).toBe('global');
    expect(research.description).toBe('parallel research');
  });

  it('finds a workflow file by name (global)', async () => {
    const { findWorkflowFile } = await loadDiscovery();
    const dir = path.join(agentDir, 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'demo.js'), 'return 1;');
    expect(findWorkflowFile('demo', projectDir, false)).toBe(path.join(dir, 'demo.js'));
  });

  it('project workflows are visible only when trusted', async () => {
    const { listWorkflows, findWorkflowFile } = await loadDiscovery();
    const dir = path.join(projectDir, '.pi', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'secret.js'), 'return 1;');

    expect(listWorkflows(projectDir, false).find((i) => i.name === 'secret')).toBeUndefined();
    expect(findWorkflowFile('secret', projectDir, false)).toBeUndefined();
    expect(listWorkflows(projectDir, true).find((i) => i.name === 'secret')?.scope).toBe('project');
    expect(findWorkflowFile('secret', projectDir, true)).toBe(path.join(dir, 'secret.js'));
  });

  it('global shadows a same-named project workflow', async () => {
    const { listWorkflows } = await loadDiscovery();
    const gDir = path.join(agentDir, 'workflows');
    const pDir = path.join(projectDir, '.pi', 'workflows');
    fs.mkdirSync(gDir, { recursive: true });
    fs.mkdirSync(pDir, { recursive: true });
    fs.writeFileSync(path.join(gDir, 'dup.js'), 'return 1;');
    fs.writeFileSync(path.join(pDir, 'dup.js'), 'return 2;');
    const items = listWorkflows(projectDir, true);
    expect(items.filter((i) => i.name === 'dup')).toHaveLength(1);
    expect(items.find((i) => i.name === 'dup')?.scope).toBe('global');
  });

  it('rejects path-like names (no escaping the workflows dirs)', async () => {
    const { findWorkflowFile } = await loadDiscovery();
    expect(findWorkflowFile('..', projectDir, true)).toBeUndefined();
    expect(findWorkflowFile('../etc/passwd', projectDir, true)).toBeUndefined();
    expect(findWorkflowFile('a/b', projectDir, true)).toBeUndefined();
  });

  it('returns empty list when no dirs exist', async () => {
    const { listWorkflows } = await loadDiscovery();
    expect(listWorkflows(projectDir, true)).toEqual([]);
  });
});
