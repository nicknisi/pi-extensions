/**
 * The workflow script engine — pi-free and testable.
 *
 * A workflow script is a JavaScript statement body with injected globals
 * (args, agent, parallel, pipeline, phase, log, budget, cwd) and a leading
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
  maxTurns?: number;
  outputSchema?: unknown;
}

export type EngineSpawnFn = (opts: EngineSpawnOptions) => Promise<EngineSpawnResult>;

export interface EngineBudget {
  total: number;
  spent: number;
  remaining: number;
}

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
  onLog?: (line: string) => void;
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

  const phase = (name: string): void => {
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
  const agent = async (prompt: string, agentOpts: Record<string, unknown> = {}): Promise<unknown> => {
    if (typeof agentOpts.agentType === 'string') {
      log(`(agentType '${agentOpts.agentType}' accepted but ignored — no agent-type registry)`);
    }
    const spawnOpts: EngineSpawnOptions = {
      prompt,
      ...(typeof agentOpts.label === 'string' ? { agent: agentOpts.label } : {}),
      ...(typeof agentOpts.model === 'string' ? { model: agentOpts.model } : {}),
      ...(Array.isArray(agentOpts.tools) ? { tools: agentOpts.tools as string[] } : { tools: DEFAULT_TOOLS }),
      ...(typeof agentOpts.systemPrompt === 'string' ? { systemPrompt: agentOpts.systemPrompt } : {}),
      ...(typeof agentOpts.effort === 'string' ? { thinkingLevel: agentOpts.effort } : {}),
      ...(typeof agentOpts.timeoutMs === 'number' ? { timeoutMs: agentOpts.timeoutMs } : {}),
      ...(typeof agentOpts.maxTurns === 'number' ? { maxTurns: agentOpts.maxTurns } : {}),
      ...(agentOpts.schema !== undefined ? { outputSchema: agentOpts.schema } : {}),
    };
    const res = await spawn(spawnOpts);
    addUsage(usage, res.usage);
    if (!res.ok) throw new Error(`${res.kind}: ${res.error}`);
    return res.data ?? res.text ?? null;
  };

  const parallel = <T>(thunks: Array<() => Promise<T>>): Promise<T[]> => Promise.all(thunks.map((t) => t()));

  // pipeline(items, ...stages): each stage maps over the previous stage's
  // outputs in parallel, producing the next array. A fold over Promise.all.
  const pipeline = async <T, U>(items: T[], ...stages: Array<(item: T, index: number) => Promise<U>>): Promise<U[]> => {
    let values: unknown[] = [...items];
    for (const stage of stages) {
      values = await parallel((values as T[]).map((v, i) => () => stage(v, i)));
    }
    return values as U[];
  };

  // Compile: rewrite `export const meta =` so the vm compiles (a stranded
  // `export` fails loudly) AND meta is captured into a holder passed as a
  // function parameter — runInThisContext cannot see a closure variable, so
  // the holder rides the call. The body keeps a local `meta` binding too, so
  // scripts that reference `meta` later still work. The body is wrapped in an
  // async function so a top-level `return` compiles.
  const metaHolder: { value: ScriptMeta | undefined } = { value: undefined };
  const stripped = script.replace(STRIP_META, 'const meta = metaHolder.value =');
  const wrapped = `(async function(args, agent, parallel, pipeline, phase, log, budget, cwd, metaHolder){\n${stripped}\n})`;
  const fn = new vm.Script(wrapped, { filename: 'workflow.js' }).runInThisContext() as (
    args: unknown,
    agent: unknown,
    parallel: unknown,
    pipeline: unknown,
    phase: unknown,
    log: unknown,
    budget: unknown,
    cwd: string,
    metaHolder: { value: ScriptMeta | undefined },
  ) => Promise<unknown>;

  const value = await fn(args, agent, parallel, pipeline, phase, log, budget, cwd, metaHolder);
  return { value, meta: metaHolder.value, logs, usage, durationMs: Date.now() - startedAt };
}
