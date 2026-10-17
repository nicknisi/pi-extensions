/**
 * The workflow script engine — pi-free and testable.
 *
 * A workflow script is a JavaScript statement body with injected globals
 * (args, agent, parallel, pipeline, phase, log, budget, cwd, checkpoint, ask) and a leading
 * `export const meta = { name, description }` declaration. It returns a value
 * by evaluating a trailing expression or a top-level `return` (the body is
 * wrapped in an async function so a bare `return` compiles).
 *
 * This module deliberately imports nothing from pi or @nicknisi/pi-shared so
 * the test suite can exercise it without an install step: the spawn function
 * is injected. index.ts wires it to the shared subagent runtime.
 *
 * The compile model mirrors ~/Developer/ideation/workflows/engine-host.mjs:
 * `export const meta =` is rewritten to an outer-binding assignment so the vm
 * compiles (a stranded `export` fails loudly) and the tool can surface
 * meta.name/description.
 */

import { createHash } from 'node:crypto';
import vm from 'node:vm';

// ── Public types ───────────────────────────────────────────────────────────

export interface EngineSpawnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number | undefined;
}

export interface EngineSpawnOk {
  ok: true;
  text: string;
  data?: unknown;
  usage: EngineSpawnUsage;
  /** Run id of the child spawn, when the spawn fn attaches it. */
  runId?: string;
  /** Path to the worktree `.patch` file, for `worktree: true` runs that changed files. */
  patchPath?: string;
}

export interface EngineSpawnFail {
  ok: false;
  kind: string;
  error: string;
  text: string;
  usage: EngineSpawnUsage;
}

export type EngineSpawnResult = EngineSpawnOk | EngineSpawnFail;

export interface EngineSpawnOptions {
  prompt: string;
  agent?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  thinkingLevel?: string;
  timeoutMs?: number;
  /** Abort (kind 'stalled') after this long without child output; tool time excluded. */
  stallMs?: number;
  maxTurns?: number;
  outputSchema?: unknown;
  /** Run the child in an isolated git worktree; its change set is captured to a `.patch`. */
  worktree?: boolean;
  /** Per-agent abort (stop or restart one agent). Not part of the replay key. */
  signal?: AbortSignal;
}

export type EngineSpawnFn = (opts: EngineSpawnOptions) => Promise<EngineSpawnResult>;

export interface EngineBudget {
  total: number;
  spent: number;
  remaining: number;
}

// ── Run gate (pause/resume) ────────────────────────────────────────────────
// A per-run hold. agent() awaits gate.wait() before every spawn, so pausing
// lets the in-flight step finish and holds the run before the next one — the
// script contract's equivalent of osolmaz/pi-workflows' `/workflow pause`.
// abort() rejects current AND future waiters so a stopped run never hangs
// parked at a gate.

export interface RunGate {
  readonly paused: boolean;
  pause(): void;
  resume(): void;
  /** Reject all current and future waiters (run stopped/timed out). */
  abort(): void;
  wait(): Promise<void>;
}

export function createRunGate(): RunGate {
  let paused = false;
  let aborted = false;
  let waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  return {
    get paused() {
      return paused;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      const w = waiters;
      waiters = [];
      for (const { resolve } of w) resolve();
    },
    abort() {
      aborted = true;
      const w = waiters;
      waiters = [];
      for (const { reject } of w) reject(new Error('run aborted while paused'));
    },
    wait() {
      if (aborted) return Promise.reject(new Error('run aborted while paused'));
      if (!paused) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

/** Script-global human question: select when options given, confirm otherwise. undefined = dismissed. */
export type EngineAskFn = (question: string, options?: string[]) => Promise<string | boolean | undefined>;

export interface ScriptMeta {
  name?: string;
  description?: string;
  [k: string]: unknown;
}

export interface RunScriptOptions {
  script: string;
  args?: unknown;
  spawn: EngineSpawnFn;
  cwd: string;
  budgetTotal?: number;
  /** Default stall window for agents that don't pass `stallMs`. */
  stallMs?: number;
  onLog?: (line: string) => void;
  /** Pause gate; agent() awaits it before every spawn. */
  gate?: RunGate;
  /**
   * Host-side human gate for the `checkpoint(label?)` global. When omitted,
   * checkpoint is a no-op that logs a skip note (pi-free hosts, tests).
   */
  checkpoint?: (label?: string) => Promise<void>;
  /**
   * Host-side human question for the `ask(question, options?)` global. When
   * omitted, ask throws — a script that needs an answer should fail loudly
   * rather than invent one.
   */
  ask?: EngineAskFn;
  /** Relaunch replay; omit for a fresh run with no journal. */
  replay?: Replay;
  /** Called once per agent() call with its live state object. */
  onAgent?: (state: AgentState) => void;
  /** Called with the script's `meta` as soon as it compiles. */
  onMeta?: (meta: ScriptMeta | undefined) => void;
}

/** Live, mutable view of one agent() call, for progress UIs. */
export interface AgentState {
  /** Start order within the run — also the replay position. */
  seq: number;
  label?: string;
  /** The phase() in effect when the agent started. */
  phase?: string;
  prompt: string;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'cached';
  attempts: number;
  usage: EngineSpawnUsage;
  startedAt: number;
  endedAt?: number;
  /** Final text (successful agents) — bounded by the child's own output. */
  result?: string;
  error?: string;
  /** Abort this agent; it settles as failed (null inside parallel/pipeline). */
  stop(): void;
  /** Abort the current attempt and start again from the same prompt. */
  restart(): void;
}

/** One settled agent, as recorded for relaunch. */
export interface JournalEntry {
  seq: number;
  key: string;
  result: EngineSpawnResult;
}

/**
 * Relaunch replay. take() is called synchronously in start order: agents whose
 * position and inputs match a prior successful run return its saved result;
 * the first mismatch, failure, or gap — and every agent after it — runs again.
 */
export interface Replay {
  take(seq: number, key: string): EngineSpawnOk | undefined;
  record(entry: JournalEntry): void;
}

export function createReplay(prior: JournalEntry[], record: (entry: JournalEntry) => void = () => {}): Replay {
  const bySeq = new Map(prior.map((e) => [e.seq, e]));
  let diverged = false;
  return {
    take(seq, key) {
      if (diverged) return undefined;
      const entry = bySeq.get(seq);
      if (entry?.key === key && entry.result.ok) return entry.result;
      diverged = true;
      return undefined;
    },
    record,
  };
}

/** Replay key: everything that determines what an agent does. */
export function agentKey(opts: EngineSpawnOptions): string {
  // The stall window changes when an agent restarts, not what it does.
  const { signal: _signal, stallMs: _stallMs, ...rest } = opts;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export interface RunScriptResult {
  value: unknown;
  meta: ScriptMeta | undefined;
  logs: string[];
  usage: EngineSpawnUsage;
  durationMs: number;
}

// ── Internals ──────────────────────────────────────────────────────────────

const STRIP_META = /export\s+const\s+meta\s*=/;
const DEFAULT_TOOLS = ['read', 'grep', 'find', 'ls'];
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_CHARS = 2000;
/** Runaway guard: agent() calls allowed in one run. */
export const MAX_AGENTS_PER_RUN = 1000;
/** parallel()/pipeline() reject longer lists instead of silently dropping work. */
export const MAX_ITEMS_PER_CALL = 4096;
/** A stalled agent restarts from the same prompt at most this many times. */
export const MAX_STALL_RESTARTS = 5;

/** An agent() call that settled with a failure (crash, empty, schema, abort). */
export class AgentFailure extends Error {
  constructor(
    readonly kind: string,
    detail: string,
  ) {
    super(`${kind}: ${detail}`);
    this.name = 'AgentFailure';
  }
}

function truncate(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max)}…[truncated at ${max} chars]`;
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function zeroUsage(): EngineSpawnUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(a: EngineSpawnUsage, b: EngineSpawnUsage): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.totalTokens += b.totalTokens;
  if (b.cost !== undefined) a.cost = (a.cost ?? 0) + b.cost;
}

// ── Engine ─────────────────────────────────────────────────────────────────

export async function runScript(opts: RunScriptOptions): Promise<RunScriptResult> {
  const { script, spawn, cwd } = opts;
  const args = opts.args;
  const budgetTotal = opts.budgetTotal ?? Infinity;
  const logs: string[] = [];
  const usage = zeroUsage();
  const startedAt = Date.now();

  const log = (...parts: unknown[]): void => {
    if (logs.length >= MAX_LOG_ENTRIES) return;
    const line = parts.map(safeStringify).join(' ');
    const t = truncate(line, MAX_LOG_CHARS);
    logs.push(t);
    opts.onLog?.(t);
  };

  let currentPhase: string | undefined;
  const phase = (name: string): void => {
    currentPhase = name;
    const line = `── ${name}`;
    logs.push(line);
    opts.onLog?.(line);
  };

  const budget: EngineBudget = {
    get total() {
      return budgetTotal;
    },
    get spent() {
      return usage.totalTokens;
    },
    get remaining() {
      return budgetTotal - usage.totalTokens;
    },
  };

  // agent(prompt, opts) backed by the injected spawn. A failure kind becomes
  // a throw so a script's safeAgent wrapper converts it into a typed stage
  // failure (matching ~/Developer/ideation/workflows/engine-host.mjs).
  let agentCount = 0;
  const agent = async (prompt: string, agentOpts: Record<string, unknown> = {}): Promise<unknown> => {
    if (++agentCount > MAX_AGENTS_PER_RUN) {
      throw new Error(`agent cap reached: a run may start at most ${MAX_AGENTS_PER_RUN} agents`);
    }
    if (typeof agentOpts.agentType === 'string') {
      log(`(agentType '${agentOpts.agentType}' accepted but ignored — no agent-type registry)`);
    }
    const seq = agentCount - 1;
    const spawnOpts: EngineSpawnOptions = {
      prompt,
      ...(typeof agentOpts.label === 'string' ? { agent: agentOpts.label } : {}),
      ...(typeof agentOpts.model === 'string' ? { model: agentOpts.model } : {}),
      ...(Array.isArray(agentOpts.tools) ? { tools: agentOpts.tools as string[] } : { tools: DEFAULT_TOOLS }),
      ...(typeof agentOpts.systemPrompt === 'string' ? { systemPrompt: agentOpts.systemPrompt } : {}),
      ...(typeof agentOpts.effort === 'string' ? { thinkingLevel: agentOpts.effort } : {}),
      ...(typeof agentOpts.timeoutMs === 'number' ? { timeoutMs: agentOpts.timeoutMs } : {}),
      ...(typeof agentOpts.stallMs === 'number'
        ? { stallMs: agentOpts.stallMs }
        : opts.stallMs !== undefined
          ? { stallMs: opts.stallMs }
          : {}),
      ...(typeof agentOpts.maxTurns === 'number' ? { maxTurns: agentOpts.maxTurns } : {}),
      ...(agentOpts.schema !== undefined ? { outputSchema: agentOpts.schema } : {}),
      ...(agentOpts.worktree === true ? { worktree: true } : {}),
    };
    // Replay lookup must run before the first await so it happens in start order.
    const key = opts.replay ? agentKey(spawnOpts) : '';
    const cached = opts.replay?.take(seq, key);

    let attempt: AbortController | undefined;
    let stopped = false;
    let restartRequested = false;
    const state: AgentState = {
      seq,
      ...(spawnOpts.agent !== undefined ? { label: spawnOpts.agent } : {}),
      ...(currentPhase !== undefined ? { phase: currentPhase } : {}),
      prompt,
      status: 'waiting',
      attempts: 0,
      usage: zeroUsage(),
      startedAt: Date.now(),
      stop() {
        stopped = true;
        attempt?.abort();
      },
      restart() {
        if (state.status !== 'running') return;
        restartRequested = true;
        attempt?.abort();
      },
    };
    opts.onAgent?.(state);

    const settle = (res: EngineSpawnResult, status: AgentState['status']): void => {
      state.status = status;
      state.endedAt = Date.now();
      if (res.ok) state.result = res.text;
      else state.error = `${res.kind}: ${res.error}`;
      opts.replay?.record({ seq, key, result: res });
    };

    // Pause gate: hold here (between steps) until resumed. Rejects once the
    // run is stopped, so a stopped script can't keep replaying or spawning.
    await opts.gate?.wait();
    let res: EngineSpawnResult;
    if (cached) {
      settle(cached, 'cached');
      res = cached;
    } else {
      state.status = 'running';
      let stallRestarts = 0;
      for (;;) {
        if (stopped) {
          res = { ok: false, kind: 'aborted', error: 'Stopped', text: '', usage: zeroUsage() };
          break;
        }
        attempt = new AbortController();
        state.attempts++;
        res = await spawn({ ...spawnOpts, signal: attempt.signal });
        addUsage(usage, res.usage);
        addUsage(state.usage, res.usage);
        const manualRestart = !res.ok && res.kind === 'aborted' && restartRequested && !stopped;
        restartRequested = false;
        const stallRestart = !res.ok && res.kind === 'stalled' && !stopped && stallRestarts < MAX_STALL_RESTARTS;
        if (!manualRestart && !stallRestart) break;
        if (stallRestart) stallRestarts++;
        log(
          `${spawnOpts.agent ?? 'agent'} ${manualRestart ? 'restarted' : 'stalled'}; starting again from the same prompt`,
        );
      }
      if (!res.ok && res.kind === 'stalled') {
        res = { ...res, error: `agent stalled on all ${state.attempts} attempts (${res.error})` };
      }
      settle(res, res.ok ? 'done' : 'failed');
    }

    if (!res.ok) throw new AgentFailure(res.kind, res.error);
    // A worktree run that changed files produces a `.patch`; surface it
    // alongside the value so the script can hand the path to a judge or
    // return it for the `/patches` apply flow. Opt-in: only when patchPath is
    // present, so non-worktree scripts see the unchanged `data ?? text` return.
    if (res.patchPath) return { value: res.data ?? res.text ?? null, patchPath: res.patchPath, runId: res.runId };
    return res.data ?? res.text ?? null;
  };

  // checkpoint(label?): script-internal human gate. The host decides what
  // "continue?" means (a confirm dialog in pi); default is a logged no-op.
  const checkpoint = async (label?: string): Promise<void> => {
    if (!opts.checkpoint) {
      log(`(checkpoint${label ? ` '${label}'` : ''} skipped — no host gate)`);
      return;
    }
    log(`⏸ checkpoint${label ? `: ${label}` : ''}`);
    await opts.checkpoint(label);
  };

  // ask(question, options?) — human answer inside a run. select with options,
  // confirm without. Default throws: never invent an answer.
  const ask: EngineAskFn = async (question, options) => {
    if (!opts.ask) throw new Error('ask() unavailable in this host');
    log(`? ${question}`);
    return opts.ask(question, options);
  };

  // A failed agent inside parallel()/pipeline() becomes null so one failure
  // doesn't collapse the wave; awaited directly, agent() still throws.
  const parallel = <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> => {
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new Error(`parallel() takes at most ${MAX_ITEMS_PER_CALL} items (got ${thunks.length})`);
    }
    return Promise.all(
      thunks.map((t) =>
        t().catch((err: unknown) => {
          if (!(err instanceof AgentFailure)) throw err;
          log(`agent failed (null in results): ${err.message}`);
          return null;
        }),
      ),
    );
  };

  // pipeline(items, ...stages): each stage maps over the previous stage's
  // outputs in parallel, producing the next array. Items that became null
  // (a failed agent) skip the remaining stages and stay null.
  const pipeline = async <T, U>(items: T[], ...stages: Array<(item: T, index: number) => Promise<U>>): Promise<U[]> => {
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new Error(`pipeline() takes at most ${MAX_ITEMS_PER_CALL} items (got ${items.length})`);
    }
    let values: unknown[] = [...items];
    for (const [stageIndex, stage] of stages.entries()) {
      values = await parallel(
        (values as T[]).map((v, i) => () => (stageIndex > 0 && v === null ? Promise.resolve(null) : stage(v, i))),
      );
    }
    return values as U[];
  };

  // Compile + run. compileScript is extracted so callers (tests, future
  // tooling) can compile + read `meta` without a real spawn.
  const compiled = compileScript(script);
  opts.onMeta?.(compiled.meta);
  const value = await compiled.fn(args, agent, parallel, pipeline, phase, log, budget, cwd, checkpoint, ask);
  return { value, meta: compiled.meta, logs, usage, durationMs: Date.now() - startedAt };
}

// ── Compile-only entry ────────────────────────────────────────────────────

/** The compiled async body; invoking it runs the script with injected globals. */
export type CompiledFn = (
  args: unknown,
  agent: unknown,
  parallel: unknown,
  pipeline: unknown,
  phase: unknown,
  log: unknown,
  budget: unknown,
  cwd: string,
  checkpoint: unknown,
  ask: unknown,
) => Promise<unknown>;

export interface CompiledScript {
  /** The script's `meta` export, read via a stub dry-run (no real spawn). */
  meta: ScriptMeta | undefined;
  /** Invoke to run the script; spawn-backed globals must be supplied. */
  fn: CompiledFn;
}

/**
 * Compile a workflow script and read its `meta` export WITHOUT a real spawn.
 *
 * `export const meta =` is rewritten to an outer-binding assignment so the vm
 * compiles (a stranded `export` fails loudly) and `meta` is captured into a
 * holder. The body is wrapped in an async function so a top-level `return`
 * compiles. `meta` is populated by a stub dry-run — `agent` returns `null`,
 * `parallel`/`pipeline` are `Promise.all`-style folds over those stubs — so the
 * script's `meta` declaration (which well-formed scripts place first) is read
 * without spawning any child sessions. A syntax error throws here.
 */
export function compileScript(script: string): CompiledScript {
  const metaHolder: { value: ScriptMeta | undefined } = { value: undefined };
  const stripped = script.replace(STRIP_META, 'const meta = metaHolder.value =');
  const wrapped = `(async function(args, agent, parallel, pipeline, phase, log, budget, cwd, checkpoint, ask, metaHolder){\n${stripped}\n})`;
  const raw = new vm.Script(wrapped, { filename: 'workflow.js' }).runInThisContext() as (
    args: unknown,
    agent: unknown,
    parallel: unknown,
    pipeline: unknown,
    phase: unknown,
    log: unknown,
    budget: unknown,
    cwd: string,
    checkpoint: unknown,
    ask: unknown,
    metaHolder: { value: ScriptMeta | undefined },
  ) => Promise<unknown>;
  // Bind metaHolder so callers invoke a 10-arg fn; the holder rides the call
  // (runInThisContext cannot see a closure variable, so it must be a parameter).
  const fn: CompiledFn = (args, agent, parallel, pipeline, phase, log, budget, cwd, checkpoint, ask) =>
    raw(args, agent, parallel, pipeline, phase, log, budget, cwd, checkpoint, ask, metaHolder);

  // Stub dry-run to read `meta`. Well-formed scripts declare `meta` first, so
  // it is assigned synchronously before the first `await`; we await the whole
  // stubbed body anyway so a script that computes meta from `args` works too.
  // Any throw is swallowed — we only care that it compiled + set meta.
  const stubAgent = async (): Promise<null> => null;
  const stubParallel = <T>(thunks: Array<() => Promise<T>>): Promise<T[]> => Promise.all(thunks.map((t) => t()));
  const stubPipeline = async <T, U>(items: T[], ...stages: Array<(item: T) => Promise<U>>): Promise<U[]> => {
    let values: unknown[] = [...items];
    for (const stage of stages) values = await stubParallel((values as T[]).map((v) => () => stage(v)));
    return values as U[];
  };
  const stubBudget = { total: Infinity, spent: 0, remaining: Infinity };
  const stubCheckpoint = async (): Promise<void> => {};
  const stubAsk = async (): Promise<undefined> => undefined;
  void fn(
    undefined,
    stubAgent,
    stubParallel,
    stubPipeline,
    () => {},
    () => {},
    stubBudget,
    '/tmp',
    stubCheckpoint,
    stubAsk,
  ).catch(() => {});

  // `meta` is a getter so a caller that re-runs `fn` with real globals sees
  // the post-run meta (the stub dry-run may have thrown on args-derived meta;
  // the real run sets it). For static meta the stub already populated it.
  return Object.defineProperty({ fn }, 'meta', {
    get: () => metaHolder.value,
    enumerable: true,
  }) as CompiledScript;
}
