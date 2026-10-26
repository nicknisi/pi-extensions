/**
 * Workflow runs: ids, background execution, the per-session registry the
 * progress view reads, and the on-disk journal that makes a run relaunchable.
 *
 * Layout: <root>/<wf-id>/{script.js, run.json, journal.jsonl}. The journal
 * holds one line per settled agent (start order, replay key, result); a
 * relaunch replays it through engine.createReplay.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOST_EXIT, pidAlive } from '@nicknisi/pi-shared';
import {
  createReplay,
  createRunGate,
  runScript,
  type AgentState,
  type EngineAskFn,
  type EngineSpawnFn,
  type EngineSpawnUsage,
  type JournalEntry,
  type RunGate,
  type ScriptMeta,
} from './engine.js';

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface WorkflowRun {
  id: string;
  label: string;
  status: WorkflowStatus;
  meta?: ScriptMeta | undefined;
  gate: RunGate;
  controller: AbortController;
  /** phase() titles in first-seen order. */
  phases: string[];
  agents: AgentState[];
  logs: string[];
  startedAt: number;
  endedAt?: number;
  dir: string;
  /** Stopped because its pi session ended (HOST_EXIT); it relaunches when that session reopens. */
  interrupted?: boolean;
  /** Formatted result (completed) or error (failed/stopped). */
  summary?: string;
  /** Settles when the run ends; never rejects. */
  done: Promise<void>;
}

export type WorkflowRuns = Map<string, WorkflowRun>;

interface StoredRun {
  id: string;
  label: string;
  args?: unknown;
  status: WorkflowStatus;
  meta?: ScriptMeta | undefined;
  startedAt: number;
  endedAt?: number | undefined;
  agents?: number;
  /** Owning pi session file and host pid: how a reopened session finds its interrupted runs. */
  ownerSession?: string | undefined;
  hostPid?: number;
  interrupted?: boolean | undefined;
}

export interface RunUi {
  confirm: (title: string, message: string) => Promise<boolean>;
  select: (title: string, options: string[]) => Promise<string | undefined>;
}

export interface StartRunOptions {
  root: string;
  script: string;
  args: unknown;
  label: string;
  cwd: string;
  /** Builds the spawn fn bound to this run's abort signal. */
  spawn: (runSignal: AbortSignal) => EngineSpawnFn;
  /** Relaunch this run id: completed agents replay from its journal. */
  relaunch?: string | undefined;
  /** Default stall window for agents. */
  stallMs?: number | undefined;
  /** Optional wall-clock cap. Default none. */
  timeoutMs?: number | undefined;
  /** Abort source besides stop (e.g. a foreground tool call's signal). */
  signal?: AbortSignal | undefined;
  /** Owning pi session file; recorded so the session can relaunch the run if pi exits mid-run. */
  ownerSession?: string | undefined;
  ui?: RunUi | undefined;
  /** Called on every state change (agent start/settle, phase, end). */
  onChange?: () => void;
}

const MAX_RESULT_CHARS = 16 * 1024;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 2000;

export function newRunId(): string {
  return `wf-${randomUUID().slice(0, 8)}`;
}

export function isWorkflowRunId(id: string): boolean {
  return /^wf-[0-9a-f]{8}$/.test(id);
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readStoredRun(root: string, id: string): (StoredRun & { script: string }) | undefined {
  if (!isWorkflowRunId(id)) return undefined;
  try {
    const dir = path.join(root, id);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as StoredRun;
    return { ...stored, script: fs.readFileSync(path.join(dir, 'script.js'), 'utf8') };
  } catch {
    return undefined;
  }
}

/** Journal lines in file order; a later line for the same seq wins. */
export function readJournal(dir: string): JournalEntry[] {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const bySeq = new Map<number, JournalEntry>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as JournalEntry;
      if (typeof entry.seq === 'number' && typeof entry.key === 'string' && entry.result) bySeq.set(entry.seq, entry);
    } catch {
      // a torn last line from a crash — ignore it
    }
  }
  return [...bySeq.values()];
}

/**
 * Ids of runs `ownerSession` owns that pi cut off: stopped with HOST_EXIT, or
 * still `running` under a host pid that is gone (a crash). Relaunching them
 * replays their finished agents from the journal.
 */
export function findInterruptedRuns(root: string, ownerSession: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!isWorkflowRunId(name)) continue;
    let stored: StoredRun;
    try {
      stored = JSON.parse(fs.readFileSync(path.join(root, name, 'run.json'), 'utf8')) as StoredRun;
    } catch {
      continue;
    }
    if (stored.ownerSession !== ownerSession) continue;
    const crashed =
      stored.status === 'running' &&
      typeof stored.hostPid === 'number' &&
      stored.hostPid !== process.pid &&
      !pidAlive(stored.hostPid);
    if (stored.interrupted || crashed) ids.push(name);
  }
  return ids;
}

/** Delete run dirs older than maxAgeMs. Best-effort. */
export function sweepWorkflowRuns(root: string, maxAgeMs: number, now = Date.now()): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isWorkflowRunId(name)) continue;
    const dir = path.join(root, name);
    try {
      if (now - fs.statSync(dir).mtimeMs > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated at ${max} chars]`;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return truncate(value, MAX_RESULT_CHARS);
  if (value === undefined) return '(undefined — did the script forget to return a value?)';
  try {
    return truncate(JSON.stringify(value, null, 2) ?? String(value), MAX_RESULT_CHARS);
  } catch {
    return truncate(String(value), MAX_RESULT_CHARS);
  }
}

/** Tokens spent by this run's agents so far (replayed agents cost nothing). */
export function runUsage(run: WorkflowRun): EngineSpawnUsage {
  const usage: EngineSpawnUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const a of run.agents) {
    usage.inputTokens += a.usage.inputTokens;
    usage.outputTokens += a.usage.outputTokens;
    usage.totalTokens += a.usage.totalTokens;
  }
  return usage;
}

export function agentCounts(run: WorkflowRun): { total: number; running: number; done: number; failed: number } {
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const a of run.agents) {
    if (a.status === 'running' || a.status === 'waiting') running++;
    else if (a.status === 'failed') failed++;
    else done++;
  }
  return { total: run.agents.length, running, done, failed };
}

/** One-line run summary: id, label, status, agent counts, tokens, duration. */
export function formatRunLine(run: WorkflowRun): string {
  const c = agentCounts(run);
  const state = run.status === 'running' && run.gate.paused ? 'paused' : run.status;
  const secs = Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000);
  const name = run.meta?.name && run.meta.name !== run.label ? ` (${run.meta.name})` : '';
  const failed = c.failed > 0 ? `, ${c.failed} failed` : '';
  return `${run.id} ${run.label}${name} — ${state} · ${c.done}/${c.total} agents done${failed} · ${runUsage(run).totalTokens} tok · ${secs}s`;
}

/** Multi-line status: summary line plus per-phase agent counts. */
export function formatRunStatus(run: WorkflowRun): string {
  const lines = [formatRunLine(run)];
  const byPhase = new Map<string, AgentState[]>();
  for (const a of run.agents) {
    const key = a.phase ?? '(no phase)';
    byPhase.set(key, [...(byPhase.get(key) ?? []), a]);
  }
  for (const [phase, agents] of byPhase) {
    const done = agents.filter((a) => a.status === 'done' || a.status === 'cached').length;
    const failed = agents.filter((a) => a.status === 'failed').length;
    lines.push(`  ${phase}: ${done}/${agents.length} done${failed ? `, ${failed} failed` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Start a workflow run in the background and register it. The returned run's
 * `done` settles when it ends (never rejects); await it for a foreground run.
 */
export function startRun(runs: WorkflowRuns, opts: StartRunOptions): WorkflowRun {
  const id = opts.relaunch ?? newRunId();
  const dir = path.join(opts.root, id);
  fs.mkdirSync(dir, { recursive: true });
  const prior = opts.relaunch ? readJournal(dir) : [];
  const journalFile = path.join(dir, 'journal.jsonl');
  fs.writeFileSync(path.join(dir, 'script.js'), opts.script);
  // Keep the prior entries: a relaunch that fails or stops early must not
  // lose the saved results it never reached. Later lines for a seq win.
  fs.writeFileSync(journalFile, prior.map((entry) => `${JSON.stringify(entry)}\n`).join(''));

  const controller = new AbortController();
  const gate = createRunGate();
  controller.signal.addEventListener('abort', () => gate.abort(), { once: true });
  const onExternalAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let timedOut = false;
  const timer =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs)
      : undefined;

  const run: WorkflowRun = {
    id,
    label: opts.label,
    status: 'running',
    gate,
    controller,
    phases: [],
    agents: [],
    logs: [],
    startedAt: Date.now(),
    dir,
    done: Promise.resolve(),
  };
  const changed = () => {
    try {
      opts.onChange?.();
    } catch {
      // UI refresh must never break a run
    }
  };
  const persist = () => {
    const stored: StoredRun = {
      id,
      label: run.label,
      args: opts.args,
      status: run.status,
      meta: run.meta,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      agents: run.agents.length,
      ownerSession: opts.ownerSession,
      hostPid: process.pid,
      interrupted: run.interrupted,
    };
    try {
      writeJson(path.join(dir, 'run.json'), stored);
    } catch {
      // persistence is best-effort; the in-memory run is authoritative
    }
  };
  persist();
  runs.set(id, run);

  // Once the run has settled (stopped, failed, finished), a script still
  // unwinding in the background must not open dialogs or touch the journal.
  let closed = false;
  const checkpoint = opts.ui
    ? async (label?: string): Promise<void> => {
        if (closed || controller.signal.aborted) throw new Error('Stopped');
        const ok = await opts.ui!.confirm('Workflow checkpoint', label ? `${label} — continue?` : 'Continue?');
        if (!ok) throw new Error(`checkpoint${label ? ` '${label}'` : ''} rejected`);
      }
    : undefined;
  const ask: EngineAskFn | undefined = opts.ui
    ? async (question, options) => {
        if (closed || controller.signal.aborted) throw new Error('Stopped');
        return options && options.length > 0
          ? opts.ui!.select(question, options)
          : opts.ui!.confirm('Workflow', question);
      }
    : undefined;

  // Stopping the run must also unblock the script promise: in-flight agents
  // settle as aborted, but a script parked in checkpoint/ask would not.
  const stopped = new Promise<never>((_, reject) =>
    controller.signal.addEventListener(
      'abort',
      () => reject(new Error(timedOut ? `Timed out after ${opts.timeoutMs}ms` : 'Stopped')),
      { once: true },
    ),
  );
  stopped.catch(() => {});

  run.done = Promise.race([
    runScript({
      script: opts.script,
      args: opts.args,
      spawn: opts.spawn(controller.signal),
      cwd: opts.cwd,
      ...(opts.stallMs !== undefined ? { stallMs: opts.stallMs } : {}),
      gate,
      ...(checkpoint ? { checkpoint } : {}),
      ...(ask ? { ask } : {}),
      replay: createReplay(prior, (entry) => {
        if (closed) return;
        try {
          fs.appendFileSync(journalFile, `${JSON.stringify(entry)}\n`);
        } catch {
          // a missing journal line only costs a re-run on relaunch
        }
        changed();
      }),
      onMeta: (meta) => {
        run.meta = meta;
        persist();
        changed();
      },
      onAgent: (state) => {
        run.agents.push(state);
        changed();
      },
      onLog: (line) => {
        if (line.startsWith('── ')) {
          const title = line.slice(3);
          if (!run.phases.includes(title)) run.phases.push(title);
        }
        if (run.logs.length < MAX_LOG_LINES) run.logs.push(truncate(line, MAX_LOG_CHARS));
        changed();
      },
    }),
    stopped,
  ])
    .then((result) => {
      run.meta = result.meta;
      run.status = 'completed';
      run.summary = formatValue(result.value);
    })
    .catch((err: unknown) => {
      run.status = controller.signal.aborted ? 'stopped' : 'failed';
      run.summary = err instanceof Error ? err.message : String(err);
      if (controller.signal.reason === HOST_EXIT) {
        run.interrupted = true;
        run.summary = 'Interrupted when the pi session ended; it relaunches when the session reopens.';
      }
    })
    .finally(() => {
      closed = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
      // Stop whatever is still in flight (a script that threw mid-fan-out).
      if (!controller.signal.aborted) controller.abort();
      for (const a of run.agents) {
        if (a.status === 'running' || a.status === 'waiting') a.stop();
      }
      run.endedAt = Date.now();
      persist();
      changed();
    });
  return run;
}

/** Final message for a settled run: status line, result or error, and logs. */
export function formatRunResult(run: WorkflowRun): string {
  const desc = run.meta?.description ? `\n${run.meta.description}` : '';
  const body = run.summary ? `\n${run.summary}` : '';
  const logs = run.logs.filter((l) => !l.startsWith('── '));
  const logsBlock = logs.length > 0 ? `\n\nlogs (${logs.length}):\n${logs.map((l) => `  ${l}`).join('\n')}` : '';
  const relaunch =
    run.status === 'completed' ? '' : `\n\nRelaunch with workflow run relaunch=${run.id} to replay completed agents.`;
  return `${formatRunLine(run)}${desc}${body}${logsBlock}${relaunch}`;
}
