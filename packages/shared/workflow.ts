/**
 * Declarative workflow engine over the subagent runtime.
 *
 * A workflow is a list of stages with explicit (`needs`) or implicit (linear
 * chain) dependencies. The engine schedules stages over a SubagentRuntime,
 * honors the platform's two-channel handoff, and never rejects — per-stage
 * failures are typed outcomes, not exceptions.
 *
 * Semantics baked in:
 * - Two-channel handoff: (1) typed results flow to dependents via
 *   `StageContext.results`; (2) when a stage that declares `sharesTree`
 *   completes ok in a git repo, its `git diff HEAD` snapshot (bounded) flows
 *   to dependents via `StageContext.treeDiffs`.
 * - Resource exclusion: `sharesTree` stages never run concurrently with ANY
 *   other stage — they wait for the running set to drain and block new
 *   starts while queued/running. Non-sharesTree stages overlap freely.
 * - Failure containment: a failed dependency transitively skips its
 *   dependents (kind 'skipped'); an exhausted token budget skips unstarted
 *   stages (kind 'budget_exceeded'); gates that never pass fail the stage
 *   (kind 'gate_failed'). Runtime 'empty' outcomes are failures — use a
 *   `gate` to enforce content contracts and avoid vacuous passes.
 * - Control artifacts: every run persists status.json + stages/<id>.json
 *   under its runDir, enabling `resumeFrom` to skip previously-ok stages.
 *
 * The engine depends only on the SubagentRuntime TYPE (never pi runtime
 * modules), so tests drive it with a fake runtime.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { TSchema } from 'typebox';
import type { SpawnFailureKind, SpawnOptions, SpawnResult, SpawnUsage, SubagentRuntime } from './subagents.js';

const execFileAsync = promisify(execFile);

// ── Public types ───────────────────────────────────────────────────────────

export type StageOutcome =
  | { ok: true; output: string; data?: unknown; usage: SpawnUsage; durationMs: number; attempts: number }
  | {
      ok: false;
      kind: SpawnFailureKind | 'gate_failed' | 'skipped' | 'budget_exceeded';
      error: string;
      durationMs: number;
      attempts: number;
    };

export type StageOk = Extract<StageOutcome, { ok: true }>;

export interface StageContext {
  /** Outcomes of all completed stages so far, by stage id. */
  results: Record<string, StageOutcome>;
  /** Bounded `git diff HEAD` snapshots from completed sharesTree stages. */
  treeDiffs: Record<string, string>;
  cwd: string;
  runDir: string;
}

export interface WorkflowStage {
  id: string;
  /** Label, e.g. "reviewer". */
  agent?: string;
  /** Static prompt or function of dependency context (item/index set for foreach jobs). */
  prompt: string | ((ctx: StageContext, item?: unknown, index?: number) => string);
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  /** Typebox schema, passed through to the runtime; validated per spawn (per item for foreach). */
  outputSchema?: TSchema;
  /** Explicit dependencies. Default: the previously declared stage (linear chain). Explicit [] = no deps. */
  needs?: string[];
  /** Declares the stage edits/reads the shared working tree. Default false. See header for exclusion semantics. */
  sharesTree?: boolean;
  /** Fan out one spawn per item: static array, or items picked from a dependency's ok outcome. */
  foreach?: unknown[] | { from: string; pick?: (outcome: StageOk) => unknown[] };
  /**
   * Validation gate on an ok outcome. Return true to pass, or { revise: feedback }
   * to re-spawn with the feedback appended to the prompt (up to maxGateAttempts
   * total attempts). Gate exceptions fail the stage as 'gate_failed'.
   */
  gate?: (outcome: StageOk, ctx: StageContext) => true | { revise: string };
  /** Total gate-evaluated attempts before failing as 'gate_failed'. Default 2. */
  maxGateAttempts?: number;
  /** Re-spawn on crashed/empty outcomes, up to this many times. Default 0. */
  retries?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}

export interface WorkflowSpec {
  name: string;
  stages: WorkflowStage[];
  /** Scheduler cap on concurrent spawns. Default 4. */
  concurrency?: number;
  /** Stop starting new stages once summed usage exceeds this many total tokens. */
  tokenBudget?: number;
}

export interface WorkflowResult {
  ok: boolean;
  outcomes: Record<string, StageOutcome>;
  usage: SpawnUsage;
  runDir: string;
}

export interface WorkflowEvent {
  type: 'stage_start' | 'stage_complete' | 'stage_failed' | 'stage_skipped' | 'workflow_complete';
  stageId?: string;
  outcome?: StageOutcome;
}

export interface RunWorkflowOptions {
  cwd: string;
  /** Override the run directory (default: <agentDir>/workflow-runs/<name>-<timestamp>). */
  runDir?: string;
  /** A prior run's directory; stages recorded ok there are skipped and their outcomes loaded. */
  resumeFrom?: string;
  /** Aborts every stage spawn (threaded into each runtime.spawn call). */
  signal?: AbortSignal;
  onProgress?: (event: WorkflowEvent) => void;
}

// ── Internals ──────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_GATE_ATTEMPTS = 2;
const MAX_TREE_DIFF_CHARS = 64 * 1024;

interface JobOk {
  ok: true;
  output: string;
  data?: unknown;
  usage: SpawnUsage;
  durationMs: number;
  attempts: number;
}

interface JobFail {
  ok: false;
  kind: SpawnFailureKind | 'gate_failed';
  error: string;
  durationMs: number;
  attempts: number;
}

interface PendingJob {
  stageId: string;
  item: unknown;
  index: number;
}

interface ItemResult {
  index: number;
  res: JobOk | JobFail;
}

function zeroUsage(): SpawnUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(a: SpawnUsage, b: SpawnUsage): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.totalTokens += b.totalTokens;
  if (b.cost !== undefined) a.cost = (a.cost ?? 0) + b.cost;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultRunRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  return path.join(agentDir, 'workflow-runs');
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Capture the shared-tree channel: bounded `git diff HEAD` for cwd, '' when not a repo. */
async function captureTreeDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'diff', 'HEAD'], {
      maxBuffer: MAX_TREE_DIFF_CHARS * 2,
    });
    return stdout.slice(0, MAX_TREE_DIFF_CHARS);
  } catch {
    return '';
  }
}

export async function runWorkflow(
  spec: WorkflowSpec,
  runtime: SubagentRuntime,
  opts: RunWorkflowOptions,
): Promise<WorkflowResult> {
  const startedAt = Date.now();
  const runDir =
    opts.runDir ??
    path.join(defaultRunRoot(), `${sanitize(spec.name)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const onProgress = opts.onProgress;
  const concurrency = spec.concurrency ?? DEFAULT_CONCURRENCY;

  const stages = spec.stages;
  const stageById = new Map<string, WorkflowStage>();
  const state = new Map<string, 'pending' | 'running' | 'settled'>();
  const outcomes: Record<string, StageOutcome> = {};
  const treeDiffs: Record<string, string> = {};
  const stageStartedAt = new Map<string, number>();
  const expectedJobs = new Map<string, number>();
  const itemResults = new Map<string, ItemResult[]>();
  let queue: PendingJob[] = [];
  const running = new Set<Promise<void>>();
  let treeRunning = 0;
  let budgetUsed = 0;
  const totalUsage = zeroUsage();

  const makeCtx = (): StageContext => ({
    results: { ...outcomes },
    treeDiffs: { ...treeDiffs },
    cwd: opts.cwd,
    runDir,
  });

  const emit = (event: WorkflowEvent): void => {
    try {
      onProgress?.(event);
    } catch {
      // progress callbacks must never break a run
    }
  };

  const persistArtifacts = (done: boolean): void => {
    try {
      fs.mkdirSync(path.join(runDir, 'stages'), { recursive: true });
      fs.writeFileSync(
        path.join(runDir, 'status.json'),
        JSON.stringify(
          {
            name: spec.name,
            startedAt,
            updatedAt: Date.now(),
            done,
            ok: done ? stages.every((s) => outcomes[s.id]?.ok === true) : undefined,
            stages: Object.fromEntries(
              stages.map((s) => [s.id, { status: state.get(s.id) ?? 'pending', outcome: outcomes[s.id] }]),
            ),
          },
          null,
          2,
        ),
      );
    } catch {
      // artifact persistence is best-effort
    }
  };

  const persistStageArtifact = (stageId: string): void => {
    try {
      fs.mkdirSync(path.join(runDir, 'stages'), { recursive: true });
      fs.writeFileSync(
        path.join(runDir, 'stages', `${sanitize(stageId)}.json`),
        JSON.stringify(
          {
            stageId,
            outcome: outcomes[stageId],
            ...(treeDiffs[stageId] !== undefined ? { treeDiff: treeDiffs[stageId] } : {}),
          },
          null,
          2,
        ),
      );
    } catch {
      // artifact persistence is best-effort
    }
  };

  const settle = (stage: WorkflowStage, outcome: StageOutcome): void => {
    state.set(stage.id, 'settled');
    outcomes[stage.id] = outcome;
    if (outcome.ok) addUsage(totalUsage, outcome.usage);
    emit({
      type: outcome.ok
        ? 'stage_complete'
        : outcome.kind === 'skipped' || outcome.kind === 'budget_exceeded'
          ? 'stage_skipped'
          : 'stage_failed',
      stageId: stage.id,
      outcome,
    });
    persistStageArtifact(stage.id);
    persistArtifacts(false);
  };

  const buildPrompt = (stage: WorkflowStage, item: unknown, index: number, feedback: string | undefined): string => {
    let prompt = typeof stage.prompt === 'function' ? stage.prompt(makeCtx(), item, index) : stage.prompt;
    if (feedback !== undefined) {
      prompt += `\n\nRevision feedback from the gate:\n${feedback}\n\nAddress this feedback and try again.`;
    }
    return prompt;
  };

  const runJob = async (stage: WorkflowStage, item: unknown, index: number): Promise<JobOk | JobFail> => {
    const jobStart = Date.now();
    const usage = zeroUsage();
    const maxGateAttempts = stage.maxGateAttempts ?? DEFAULT_GATE_ATTEMPTS;
    const maxRetries = stage.retries ?? 0;
    let attempts = 0;
    let gateTries = 0;
    let retriesUsed = 0;
    let feedback: string | undefined;

    for (;;) {
      attempts++;
      const spawnOpts: SpawnOptions = { prompt: buildPrompt(stage, item, index, feedback), cwd: opts.cwd };
      if (stage.agent !== undefined) spawnOpts.agent = stage.agent;
      if (stage.model !== undefined) spawnOpts.model = stage.model;
      if (stage.tools !== undefined) spawnOpts.tools = stage.tools;
      if (stage.systemPrompt !== undefined) spawnOpts.systemPrompt = stage.systemPrompt;
      if (stage.outputSchema !== undefined) spawnOpts.outputSchema = stage.outputSchema;
      if (stage.maxTurns !== undefined) spawnOpts.maxTurns = stage.maxTurns;
      if (stage.maxToolCalls !== undefined) spawnOpts.maxToolCalls = stage.maxToolCalls;
      if (stage.timeoutMs !== undefined) spawnOpts.timeoutMs = stage.timeoutMs;
      if (opts.signal !== undefined) spawnOpts.signal = opts.signal;

      let res: SpawnResult;
      try {
        res = await runtime.spawn(spawnOpts);
      } catch (err) {
        // spawn() never rejects by contract; defend against foreign runtimes anyway
        res = {
          ok: false as const,
          runId: 'unknown',
          kind: 'crashed' as const,
          error: errorMessage(err),
          text: '',
          usage: zeroUsage(),
          durationMs: Date.now() - jobStart,
        };
      }
      addUsage(usage, res.usage);
      budgetUsed += res.usage.totalTokens;

      if (res.ok) {
        const outcome: StageOk = {
          ok: true,
          output: res.text,
          ...(res.data !== undefined ? { data: res.data } : {}),
          usage: { ...usage },
          durationMs: Date.now() - jobStart,
          attempts,
        };
        if (!stage.gate) return outcome;
        gateTries++;
        let verdict: true | { revise: string };
        try {
          verdict = stage.gate(outcome, makeCtx());
        } catch (err) {
          return {
            ok: false,
            kind: 'gate_failed',
            error: `Gate threw: ${errorMessage(err)}`,
            durationMs: Date.now() - jobStart,
            attempts,
          };
        }
        if (verdict === true) return outcome;
        feedback = verdict.revise;
        if (gateTries >= maxGateAttempts) {
          return {
            ok: false,
            kind: 'gate_failed',
            error: `Gate did not pass after ${gateTries} attempt(s). Last feedback: ${feedback}`,
            durationMs: Date.now() - jobStart,
            attempts,
          };
        }
        continue;
      }

      if ((res.kind === 'crashed' || res.kind === 'empty') && retriesUsed < maxRetries) {
        retriesUsed++;
        continue;
      }
      return { ok: false, kind: res.kind, error: res.error, durationMs: Date.now() - jobStart, attempts };
    }
  };

  const aggregateAndSettle = async (stage: WorkflowStage): Promise<void> => {
    const results = (itemResults.get(stage.id) ?? []).sort((a, b) => a.index - b.index);
    const durationMs = Date.now() - (stageStartedAt.get(stage.id) ?? Date.now());
    const attempts = results.reduce((n, r) => n + r.res.attempts, 0);
    const failed = results.find((r) => !r.res.ok);

    let outcome: StageOutcome;
    if (failed && !failed.res.ok) {
      const prefix = stage.foreach ? `item ${failed.index}: ` : '';
      outcome = { ok: false, kind: failed.res.kind, error: `${prefix}${failed.res.error}`, durationMs, attempts };
    } else {
      const oks = results.filter((r): r is { index: number; res: JobOk } => r.res.ok);
      const usage = zeroUsage();
      for (const r of oks) addUsage(usage, r.res.usage);
      outcome = stage.foreach
        ? {
            ok: true,
            output: JSON.stringify(
              oks.map((r) => r.res.output),
              null,
              2,
            ),
            ...(stage.outputSchema !== undefined ? { data: oks.map((r) => r.res.data) } : {}),
            usage,
            durationMs,
            attempts,
          }
        : { ...oks[0]!.res, durationMs };
    }

    if (outcome.ok && stage.sharesTree) {
      const diff = await captureTreeDiff(opts.cwd);
      if (diff) treeDiffs[stage.id] = diff;
    }
    settle(stage, outcome);
  };

  const launch = (job: PendingJob): void => {
    const stage = stageById.get(job.stageId)!;
    if (!stageStartedAt.has(stage.id)) stageStartedAt.set(stage.id, Date.now());
    if (stage.sharesTree) treeRunning++;
    const p = (async () => {
      try {
        const res = await runJob(stage, job.item, job.index);
        const list = itemResults.get(stage.id) ?? [];
        list.push({ index: job.index, res });
        itemResults.set(stage.id, list);
        if (list.length === (expectedJobs.get(stage.id) ?? 1)) {
          await aggregateAndSettle(stage);
        }
      } catch (err) {
        // runJob never throws; belt-and-braces so a bug can never wedge the scheduler
        settle(stage, {
          ok: false,
          kind: 'crashed',
          error: `engine error: ${errorMessage(err)}`,
          durationMs: Date.now() - (stageStartedAt.get(stage.id) ?? Date.now()),
          attempts: 0,
        });
      }
    })();
    const tracked = p.finally(() => {
      running.delete(tracked);
      if (stage.sharesTree) treeRunning--;
    });
    running.add(tracked);
  };

  const needsOf = (index: number): string[] => {
    const stage = stages[index]!;
    return stage.needs ?? (index === 0 ? [] : [stages[index - 1]!.id]);
  };

  // ── Spec validation ──────────────────────────────────────────────────────

  for (const stage of stages) {
    if (stageById.has(stage.id)) {
      state.set(stage.id, 'settled');
      outcomes[stage.id] = {
        ok: false,
        kind: 'skipped',
        error: `duplicate stage id '${stage.id}'`,
        durationMs: 0,
        attempts: 0,
      };
    } else {
      stageById.set(stage.id, stage);
      state.set(stage.id, 'pending');
    }
  }

  // Resume: preload previously-ok stages from a prior run's artifacts.
  if (opts.resumeFrom) {
    try {
      const dir = path.join(opts.resumeFrom, 'stages');
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          const stageId = parsed?.stageId;
          if (typeof stageId !== 'string' || parsed?.outcome?.ok !== true) continue;
          if (state.get(stageId) !== 'pending') continue;
          state.set(stageId, 'settled');
          outcomes[stageId] = parsed.outcome as StageOutcome;
          if (typeof parsed.treeDiff === 'string' && parsed.treeDiff) treeDiffs[stageId] = parsed.treeDiff;
        } catch {
          // skip unreadable stage artifact
        }
      }
    } catch {
      // no resumable artifacts — run fresh
    }
  }

  const budgetExceeded = (): boolean => spec.tokenBudget !== undefined && budgetUsed >= spec.tokenBudget;

  /** Settle pending stages whose deps failed, or that the exhausted budget strands. */
  const settleSkips = (): void => {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      if (state.get(stage.id) !== 'pending') continue;
      const needs = needsOf(i);
      const unknown = needs.find((id) => !stageById.has(id));
      if (unknown) {
        settle(stage, {
          ok: false,
          kind: 'skipped',
          error: `unknown dependency '${unknown}'`,
          durationMs: 0,
          attempts: 0,
        });
        continue;
      }
      const failedDep = needs.find((id) => {
        const o = outcomes[id];
        return o !== undefined && !o.ok;
      });
      if (failedDep) {
        settle(stage, {
          ok: false,
          kind: 'skipped',
          error: `dependency '${failedDep}' did not succeed`,
          durationMs: 0,
          attempts: 0,
        });
        continue;
      }
      if (budgetExceeded()) {
        settle(stage, {
          ok: false,
          kind: 'budget_exceeded',
          error: `token budget ${spec.tokenBudget} exceeded`,
          durationMs: 0,
          attempts: 0,
        });
      }
    }
  };

  /** Materialize pending stages whose deps are all ok into per-item jobs. */
  const materializeReady = (): void => {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      if (state.get(stage.id) !== 'pending') continue;
      if (!needsOf(i).every((id) => outcomes[id]?.ok === true)) continue;

      let items: unknown[];
      if (stage.foreach === undefined) {
        items = [undefined];
      } else if (Array.isArray(stage.foreach)) {
        items = stage.foreach;
      } else {
        const dep = outcomes[stage.foreach.from];
        try {
          if (dep === undefined || !dep.ok) throw new Error(`dependency '${stage.foreach.from}' has no ok outcome`);
          const picked = stage.foreach.pick ? stage.foreach.pick(dep) : dep.data;
          if (!Array.isArray(picked)) throw new Error(`foreach items from '${stage.foreach.from}' are not an array`);
          items = picked;
        } catch (err) {
          settle(stage, {
            ok: false,
            kind: 'crashed',
            error: `foreach resolution failed: ${errorMessage(err)}`,
            durationMs: 0,
            attempts: 0,
          });
          continue;
        }
      }

      state.set(stage.id, 'running');
      expectedJobs.set(stage.id, items.length);
      itemResults.set(stage.id, []);
      items.forEach((item, index) => queue.push({ stageId: stage.id, item, index }));
      emit({ type: 'stage_start', stageId: stage.id });
    }
  };

  /** Start queued jobs under the concurrency cap and tree-exclusion rules. */
  const tryStartJobs = (): void => {
    const kept: PendingJob[] = [];
    for (const job of queue) {
      const isTree = stageById.get(job.stageId)!.sharesTree === true;
      const treeWaiting = queue.some((j) => stageById.get(j.stageId)!.sharesTree === true);
      if (running.size >= concurrency) {
        kept.push(job);
      } else if (isTree) {
        // Tree jobs need an empty stage; while one waits, non-tree starts pause too (drain faster, no starvation).
        if (running.size === 0) launch(job);
        else kept.push(job);
      } else if (treeWaiting || treeRunning > 0) {
        kept.push(job);
      } else {
        launch(job);
      }
    }
    queue = kept;
  };

  // ── Scheduler loop ───────────────────────────────────────────────────────

  try {
    for (;;) {
      settleSkips();
      materializeReady();
      tryStartJobs();

      const pendingStages = stages.some((s) => state.get(s.id) === 'pending');
      if (running.size === 0) {
        if (!pendingStages && queue.length === 0) break;
        if (pendingStages && queue.length === 0) {
          // Nothing can ever become ready again: dependency cycle.
          for (const s of stages) {
            if (state.get(s.id) === 'pending') {
              settle(s, {
                ok: false,
                kind: 'skipped',
                error: 'dependency cycle detected',
                durationMs: 0,
                attempts: 0,
              });
            }
          }
          break;
        }
        if (queue.length > 0) {
          // Unreachable under the exclusion rules (a queued tree job with an idle
          // pool launches immediately); break defensively rather than spin.
          break;
        }
      }
      if (running.size > 0) await Promise.race(running);
    }
  } catch (err) {
    for (const s of stages) {
      if (state.get(s.id) !== 'settled') {
        settle(s, {
          ok: false,
          kind: 'crashed',
          error: `engine error: ${errorMessage(err)}`,
          durationMs: 0,
          attempts: 0,
        });
      }
    }
  }

  persistArtifacts(true);
  const result: WorkflowResult = {
    ok: stages.every((s) => outcomes[s.id]?.ok === true),
    outcomes,
    usage: totalUsage,
    runDir,
  };
  emit({ type: 'workflow_complete' });
  return result;
}
