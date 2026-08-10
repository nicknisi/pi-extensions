/**
 * codemode for the first-party subagent platform.
 *
 * One tool, `codemode`: the model writes TypeScript that orchestrates
 * subagents compositionally (Promise.all fan-out, pipelines, map/reduce),
 * and the tool compiles + runs it in-process via bundle-require, returning
 * the module's default export as the result.
 *
 * The snippet executes IN the host process with full Node access —
 * process/require/fs are all reachable. Its codemode API is three injected
 * bindings:
 *
 *   spawn(options: SpawnOptions): Promise<SpawnResult>  — shared-runtime
 *     spawn (namespace 'codemode'); never rejects, check result.ok.
 *   runWorkflow(spec: WorkflowSpec, opts?): Promise<WorkflowResult> —
 *     declarative multi-stage DAGs over spawn (needs/foreach/gates/retries,
 *     sharesTree tree-diff handoff, control artifacts); never rejects.
 *   log(...args): void — captured into the tool result's details.
 *
 * Safety posture: this executes model-written code with the host process's
 * full privileges. That is the accepted model (your model, your session) —
 * the same trust boundary as pi-codemode and any bash tool call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { getKeybindings, Text } from '@earendil-works/pi-tui';
import {
  createSubagentRuntime,
  runWorkflow,
  type RunWorkflowOptions,
  type SpawnOptions,
  type SpawnResult,
  type StageContext,
  type SubagentRuntime,
  type WorkflowEvent,
  type WorkflowResult,
  type WorkflowSpec,
  type WorkflowStage,
} from '@nicknisi/pi-shared';
import { bundleRequire } from 'bundle-require';
import { Type } from 'typebox';

const ARTIFACTS_ROOT = path.join(getAgentDir(), 'subagent-runs');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RESULT_CHARS = 16 * 1024;
const MAX_STACK_CHARS = 4000;
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_CHARS = 2000;

/** Spawn options as exposed to the codemode snippet: the shared runtime's set, plus `text` — an explicit raw-text opt-in. */
type CodemodeSpawnOptions = SpawnOptions & { text?: boolean };

// ── Runscope orchestration ledger ─────────────────────────────────────────
// Every spawn/runWorkflow lifecycle event is appended to the PARENT session
// as a typed custom entry (customType 'codemode-runscope') via pi.appendEntry.
// Custom entries persist to the session JSONL but never enter LLM context, so
// the ledger is durable and free of context-window cost. No OpenTelemetry —
// just structured spans written through the session.
const RUNSCOPE_TYPE = 'codemode-runscope';

type RunscopeKind = 'spawn_start' | 'spawn_end' | 'stage_start' | 'stage_end' | 'gate_result';

interface RunscopeEntry {
  runId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: RunscopeKind;
  ts: number;
  [extra: string]: unknown;
}

// Async context carrying the active workflow run + stage span, so a spawn
// fired inside a workflow stage can be parented to its stage even when stages
// run concurrently. `enterWith` is used (not `run`) because the spawn call
// lives inside the shared engine's runJob frame, which we cannot wrap — the
// stage's prompt wrapper is our only interception point in that frame. Each
// runJob is its own async frame, so the context does not leak across stages.
const runscopeCtx = new AsyncLocalStorage<{ runId: string; stageSpan: string }>();

const GLOBAL_KEY = '__piCodemode';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated at ${max} chars]`;
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const controller = new AbortController();
  const fire = () => controller.abort();
  for (const s of present) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', fire, { once: true });
  }
  return controller.signal;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.message}${err.stack ? `\n\n${truncate(err.stack, MAX_STACK_CHARS)}` : ''}`;
  return String(err);
}

// ── TUI rendering ────────────────────────────────────────────────────────
// Presentation only — the tool's text content stays authoritative for the
// model. Visual vocabulary matches llm-council: ✓/✗ prefixes, └─ branch
// lines, indented sub-lines, dim metadata, one accent color (the label).

interface CodemodeDetails {
  label: string;
  logs: string[];
  durationMs: number;
  error?: string;
  stack?: string;
}

/** Outcome of a codemode run: formatted text for display + the raw default export. */
interface CodemodeOutcome {
  text: string;
  details: CodemodeDetails;
  value: unknown;
  /** 1-indexed $N slot the value was bound to (only when bindResult and the run succeeded). */
  boundN?: number | undefined;
}

/** Persisted shape of a console (`=` or `/cx`) run, rendered as a custom entry. */
interface ConsoleEntryData {
  n: number; // 1-indexed $N slot this result binds to (only on success)
  label: string;
  code: string;
  text: string;
  details: CodemodeDetails;
  value: unknown; // raw default export; bound to $N and rebuilt on session load
  ts: number;
}

const SPINNER_CHARS = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()];
const SPINNER_INTERVAL_MS = 80;
const BRANCH_PREFIX = '└─';
const INDENT = '   '; // visible width of '└─' + 1
const RESULT_PREVIEW_LINES = 10;
const CODE_PREVIEW_MAX = 60;

function fg(theme: Theme, color: ThemeColor, text: string): string {
  try {
    return theme.fg(color, text);
  } catch {
    return text;
  }
}

function makeText(lastComponent: unknown, text: string): Text {
  const comp = lastComponent instanceof Text ? lastComponent : new Text('', 0, 0);
  comp.setText(text);
  return comp;
}

function branchLine(theme: Theme, text: string): string {
  return `${fg(theme, 'muted', BRANCH_PREFIX)} ${text}`;
}

function indentLine(text: string): string {
  return `${INDENT}${text}`;
}

function expandHint(theme: Theme): string {
  const key = getKeybindings().getKeys('app.tools.expand')[0] ?? 'ctrl+o';
  return fg(theme, 'dim', ` • ${key} to expand`);
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `(${Math.round(ms)}ms)`;
  if (ms < 60_000) return `(${(ms / 1000).toFixed(1)}s)`;
  return `(${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s)`;
}

/** First meaningful (non-blank) code line, trimmed and capped, plus total lines. */
function codePreview(code: string | undefined): { line: string; count: number } {
  if (!code) return { line: '...', count: 0 };
  const lines = code.split('\n');
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? '...';
  return {
    line: first.length > CODE_PREVIEW_MAX ? `${first.slice(0, CODE_PREVIEW_MAX)}…` : first,
    count: lines.length,
  };
}

function appendLogTree(lines: string[], logs: string[], theme: Theme): void {
  if (logs.length === 0) return;
  lines.push('');
  lines.push(branchLine(theme, `${fg(theme, 'muted', 'logs')} ${fg(theme, 'dim', `(${logs.length})`)}`));
  for (const entry of logs) {
    for (const line of entry.split('\n')) lines.push(indentLine(fg(theme, 'dim', line)));
  }
}

function ensureSpinner(ctx: any): number {
  if (ctx?.state?.spinnerInterval) return ctx.state.spinnerFrame ?? 0;
  if (!ctx?.state) ctx.state = {};
  ctx.state.spinnerFrame = 0;
  ctx.state.spinnerInterval = setInterval(() => {
    ctx.state.spinnerFrame = (ctx.state.spinnerFrame + 1) % SPINNER_FRAMES.length;
    ctx.invalidate?.();
  }, SPINNER_INTERVAL_MS);
  return 0;
}

function clearSpinner(ctx: any) {
  if (ctx?.state?.spinnerInterval) {
    clearInterval(ctx.state.spinnerInterval);
    ctx.state.spinnerInterval = undefined;
  }
}

function spinnerDot(theme: Theme, frame: number): string {
  return `${fg(theme, 'muted', SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)} `;
}

export default function codemode(pi: ExtensionAPI) {
  const runtime = createSubagentRuntime({ namespace: 'codemode', artifactsDir: ARTIFACTS_ROOT });

  // Append a runscope span to the parent session JSONL. Best-effort: a ledger
  // write must never fail a codemode run.
  const emitRunscope = (entry: RunscopeEntry): void => {
    try {
      pi.appendEntry(RUNSCOPE_TYPE, entry);
    } catch {
      // best-effort
    }
  };

  // Traced runtime: wraps every spawn with spawn_start/spawn_end ledger
  // entries. Used both by the snippet's `spawn` binding and by runWorkflow, so
  // every child — standalone or inside a stage — is traced. The runId/parent
  // come from the async context set by runWorkflow's stage-prompt wrapper; for
  // a standalone spawn there is no context, so runId = the spawn's own runId
  // and parentSpanId = null.
  const tracedRuntime: SubagentRuntime = {
    namespace: runtime.namespace,
    spawn: (opts) => tracedRuntime.spawnDetached(opts).done,
    spawnDetached: (opts) => {
      const { runId, done } = runtime.spawnDetached(opts);
      const span = runscopeCtx.getStore();
      const entryRunId = span?.runId ?? runId;
      const parentSpanId = span?.stageSpan ?? null;
      emitRunscope({ runId: entryRunId, spanId: runId, parentSpanId, kind: 'spawn_start', ts: Date.now() });
      void done.then((res) => {
        emitRunscope({
          runId: entryRunId,
          spanId: runId,
          parentSpanId,
          kind: 'spawn_end',
          ts: Date.now(),
          ok: res.ok,
          ...(res.ok ? {} : { failureKind: res.kind, error: res.error }),
        });
      });
      return { runId, done };
    },
    listRuns: () => runtime.listRuns(),
    activeCount: () => runtime.activeCount(),
  };

  // Snippet bindings are handed over via a single global (globalThis.__piCodemode),
  // so two concurrent executions would clobber each other's spawn/log/runWorkflow —
  // serialize runs with a promise-chain mutex.
  let execChain: Promise<unknown> = Promise.resolve();

  // ── Console session state (= inline prefix + /cx named snippets) ─────
  // Returned snippet values bind to $1, $2, … for later console snippets in
  // the session. Held in-memory; rebuilt from persisted custom entries on
  // session load. The model-facing `codemode` tool does NOT bind (it is not a
  // console snippet) — only `=` and `/cx` do.
  const CONSOLE_TYPE = 'codemode-console';
  const sessionResults: unknown[] = [];

  pi.on('session_start', (_event, ctx) => {
    sessionResults.length = 0;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === 'custom' && entry.customType === CONSOLE_TYPE) {
          const data = entry.data as ConsoleEntryData | undefined;
          // Errored runs are never bound live, so they must not occupy a $N
          // slot on rebuild either — otherwise every $N after an error shifts.
          if (data && !data.details?.error) sessionResults.push(data.value);
        }
      }
    } catch {
      // best-effort rebuild
    }
  });

  function bindingsPrelude(): string {
    let prelude = 'const { spawn, log, runWorkflow } = (globalThis as any).__piCodemode;\n';
    for (let i = 0; i < sessionResults.length; i++) {
      prelude += `const $${i + 1} = (globalThis as any).__piCodemode.results[${i}];\n`;
    }
    return prelude;
  }

  // Compile + run a snippet in-process through the same runtime as the
  // `codemode` tool. Shared by the tool, the `=` console prefix, and `/cx`.
  // Serialized via execChain because bindings ride a single global.
  async function runCodemode(input: {
    code: string;
    label: string;
    timeoutMs: number;
    cwd: string;
    externalSignal?: AbortSignal | undefined;
    bindResult?: boolean;
  }): Promise<CodemodeOutcome> {
    const { code, label, timeoutMs, cwd, externalSignal, bindResult = false } = input;
    const logs: string[] = [];
    const controller = new AbortController();

    const log = (...args: unknown[]) => {
      if (logs.length >= MAX_LOG_ENTRIES) return;
      const line = args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
      logs.push(truncate(line, MAX_LOG_CHARS));
    };

    const spawn = (options: CodemodeSpawnOptions): Promise<SpawnResult> => {
      // Output contract: a schema-less spawn returns raw text, and reading a
      // field off unparsed text fails silently (undefined, not an error) — a
      // whole fan-out can look successful while every result is unusable.
      // Require EITHER an outputSchema OR an explicit `text: true` opt-in.
      // This throws synchronously and loudly rather than returning ok:false,
      // so the run cannot be mistaken for a success.
      if (!options.outputSchema && !options.text) {
        throw new Error(
          'spawn() requires an explicit output contract: pass `outputSchema` ' +
            'for validated structured output (parsed JSON lands in result.data) ' +
            'or `text: true` to opt into raw text mode. A schema-less spawn ' +
            'without `text: true` is rejected to prevent silently-unusable ' +
            'results (reading a field off unparsed text yields undefined, not an error).',
        );
      }
      const merged = mergeSignals(options.signal, externalSignal, controller.signal);
      const { signal: _userSignal, text: _text, ...rest } = options;
      const opts: SpawnOptions = { ...rest, cwd: options.cwd ?? cwd };
      // Default children to read-only, matching dispatch; pi's own default
      // (read/bash/edit/write) would apply otherwise.
      if (opts.tools === undefined) opts.tools = ['read', 'grep', 'find', 'ls'];
      if (merged) opts.signal = merged;
      return tracedRuntime.spawn(opts);
    };

    const boundRunWorkflow = (
      spec: WorkflowSpec,
      wfOpts: Partial<RunWorkflowOptions> = {},
    ): Promise<WorkflowResult> => {
      const merged = mergeSignals(wfOpts.signal, externalSignal, controller.signal);
      const userOnProgress = wfOpts.onProgress;
      const full: RunWorkflowOptions = { cwd, ...wfOpts };
      if (merged) full.signal = merged;

      // One runId for the whole workflow; every stage/gate entry carries it.
      const wfRunId = randomUUID();
      // Derive a stage's parent span from its needs edges so the trace tree
      // mirrors the workflow DAG. A trace span has one parent, so multi-need
      // stages attach to the first need (a spanning tree of the DAG); the
      // full needs list is included in the entry for completeness.
      const parentOf = (stageId: string): string | null => {
        const idx = spec.stages.findIndex((s) => s.id === stageId);
        if (idx === -1) return null;
        const stage = spec.stages[idx]!;
        const needs = stage.needs ?? (idx === 0 ? [] : [spec.stages[idx - 1]!.id]);
        return needs[0] ?? null;
      };

      // Wrap each stage's prompt so the stage's async frame (runJob) carries
      // the runId + stage span via AsyncLocalStorage.enterWith. The shared
      // engine calls buildPrompt (and thus this wrapper) at the start of each
      // attempt inside runJob; the subsequent `await runtime.spawn(...)` in
      // the same frame inherits the context, so tracedRuntime can parent the
      // spawn's span to its stage even under concurrent stages. String
      // prompts are wrapped in a function returning the original string.
      const wrappedStages: WorkflowStage[] = spec.stages.map((stage) => {
        const origPrompt = stage.prompt;
        const promptFn = typeof origPrompt === 'function' ? origPrompt : () => origPrompt;
        const wrappedPrompt = (gctx: StageContext, item?: unknown, index?: number): string => {
          runscopeCtx.enterWith({ runId: wfRunId, stageSpan: stage.id });
          return promptFn(gctx, item, index);
        };
        const wrapped: WorkflowStage = { ...stage, prompt: wrappedPrompt };
        if (stage.gate) {
          const origGate = stage.gate;
          wrapped.gate = (outcome, gctx) => {
            const verdict = origGate(outcome, gctx);
            emitRunscope({
              runId: wfRunId,
              spanId: stage.id,
              parentSpanId: parentOf(stage.id),
              kind: 'gate_result',
              ts: Date.now(),
              passed: verdict === true,
              ...(verdict === true ? {} : { feedback: verdict.revise }),
            });
            return verdict;
          };
        }
        return wrapped;
      });

      full.onProgress = (event: WorkflowEvent) => {
        try {
          if (event.type === 'stage_start') {
            emitRunscope({
              runId: wfRunId,
              spanId: event.stageId!,
              parentSpanId: parentOf(event.stageId!),
              kind: 'stage_start',
              ts: Date.now(),
            });
          } else if (
            event.type === 'stage_complete' ||
            event.type === 'stage_failed' ||
            event.type === 'stage_skipped'
          ) {
            emitRunscope({
              runId: wfRunId,
              spanId: event.stageId!,
              parentSpanId: parentOf(event.stageId!),
              kind: 'stage_end',
              ts: Date.now(),
              ok: event.outcome?.ok,
              ...(event.outcome && !event.outcome.ok
                ? { failureKind: event.outcome.kind, error: event.outcome.error }
                : {}),
            });
          }
        } catch {
          // ledger emission is best-effort
        }
        try {
          userOnProgress?.(event);
        } catch {
          // a caller's progress callback must never break the workflow
        }
      };

      return runWorkflow({ ...spec, stages: wrappedStages }, tracedRuntime, full);
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-codemode-'));
    const file = path.join(dir, 'snippet.ts');
    fs.writeFileSync(file, bindingsPrelude() + code);
    const startedAt = Date.now();

    const runSnippet = async (): Promise<unknown> => {
      const { mod } = await bundleRequire({
        filepath: file,
        format: 'esm',
        esbuildOptions: {
          target: 'es2022',
          // Snippets may use CJS `require('node:fs')` (the tool description
          // advertises `process/require/fs` as reachable). esbuild bundles to
          // ESM and rewrites those to a `__require` shim that throws
          // `Dynamic require of "node:fs" is not supported` when `require` is
          // undefined in ESM scope. Inject a real CJS `require` via banner so
          // the shim resolves to the genuine built-in instead of throwing.
          banner: {
            js: 'import { createRequire as __piCodemodeCreateRequire } from "node:module"; const require = __piCodemodeCreateRequire(import.meta.url);',
          },
        },
      });
      return mod.default;
    };

    // Serialize executions: the snippet reads its bindings from the single
    // global set below, so two concurrent runs would clobber each other's
    // spawn/log/runWorkflow. Wait for the previous run's finally to release.
    const previous = execChain;
    let release!: () => void;
    execChain = new Promise<void>((resolve) => (release = resolve));
    await previous;

    (globalThis as any)[GLOBAL_KEY] = { spawn, log, runWorkflow: boundRunWorkflow, results: sessionResults };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const execPromise = runSnippet();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(); // in-flight spawns abort; the JS itself can't be preempted
          reject(new Error(`Timed out after ${timeoutMs}ms (in-flight subagents were aborted)`));
        }, timeoutMs);
      });
      const value = await Promise.race([execPromise, timeoutPromise]);
      execPromise.catch(() => {}); // if we raced ahead, swallow any late rejection
      const text =
        typeof value === 'string'
          ? truncate(value, MAX_RESULT_CHARS)
          : value === undefined
            ? '(undefined — did you forget `export default`?)'
            : truncate(JSON.stringify(value, null, 2) ?? String(value), MAX_RESULT_CHARS);
      // Bind inside the serialized section and report the slot actually taken —
      // computing it before the exec-chain lock races overlapping submissions.
      let boundN: number | undefined;
      if (bindResult) {
        sessionResults.push(value);
        boundN = sessionResults.length;
      }
      return { text, details: { label, logs, durationMs: Date.now() - startedAt }, value, boundN };
    } catch (err) {
      const logText = logs.length > 0 ? `\n\nCaptured logs (${logs.length}):\n${logs.join('\n')}` : '';
      return {
        text: `${label} failed:\n\n${formatError(err)}${logText}`,
        details: {
          label,
          logs,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.stack ? { stack: truncate(err.stack, MAX_STACK_CHARS) } : {}),
        },
        value: undefined,
      };
    } finally {
      if (timer) clearTimeout(timer);
      delete (globalThis as any)[GLOBAL_KEY];
      fs.rmSync(dir, { recursive: true, force: true });
      release(); // let the next queued run set its own bindings
    }
  }

  pi.registerTool({
    name: 'codemode',
    label: 'Codemode',
    description: [
      'Execute a TypeScript snippet that orchestrates subagents compositionally and returns a result.',
      'The snippet runs in-process with two injected bindings — spawn(options) and log(...args) — and',
      'MUST `export default` its result. spawn(options) launches a hermetic child agent session',
      '(in-process, no user extensions/skills/context) and resolves to a SpawnResult: on success',
      '{ ok: true, text, data?, usage, durationMs, runId }; on failure { ok: false, kind:',
      "'crashed'|'empty'|'schema_invalid'|'aborted', error, text, usage, durationMs, runId }.",
      'spawn never rejects — check result.ok. SpawnOptions: { prompt: string (required); agent?:',
      "string label; model?: string 'provider/id'; tools?: string[] allowlist (undefined = read-only",
      '[read, grep, find, ls]; pass [read, bash, edit, write] explicitly for builders); systemPrompt?:',
      'string; replaceSystemPrompt?: boolean; extensionPaths?: string[]; skillPaths?: string[];',
      'includeContextFiles?: boolean; outputSchema?: TypeBox-like JSON schema object (validated;',
      'parsed JSON lands in result.data; a schema-validating spawn that fails validation after one',
      "bounded repair attempt returns ok:false kind:'schema_invalid' — never a silently-empty string);",
      'text?: boolean (opt into raw text mode; REQUIRED when outputSchema is omitted — a spawn with',
      'neither outputSchema nor text:true is rejected immediately); cwd?: string; timeoutMs?: number',
      '(default 15 min);',
      'maxTurns?: number; maxToolCalls?: number; thinkingLevel?: string }. Composition — Promise.all',
      'Composition — Promise.all',
      'fan-out, sequential pipelines, map/reduce over files — is your code. For dependent multi-stage',
      'work use runWorkflow(spec, opts?): { name, stages: [{ id, prompt (string or (ctx, item?, index?)',
      '=> string; ctx = { results, treeDiffs, cwd, runDir }), needs?: string[] (default: previous stage),',
      'model?, tools?, systemPrompt?, outputSchema?, foreach?: unknown[] | { from: stageId, pick?: (outcome)',
      '=> unknown[] }, gate?: (outcome, ctx) => true | { revise: feedback }, maxGateAttempts?, retries?,',
      'sharesTree?: boolean (never overlaps other stages; its git diff HEAD flows to dependents via',
      'treeDiffs), maxTurns?, maxToolCalls?, timeoutMs? }], concurrency?, tokenBudget? } — resolves to',
      '{ ok, outcomes, usage, runDir }; never rejects. The snippet runs IN the host process with full',
      'Node access (process/require/fs reachable) — the same trust boundary as the bash tool. Keep the',
      'default export SMALL (summaries, counts, key findings) — never raw file dumps.',
    ].join(' '),
    promptSnippet: 'Run TypeScript that orchestrates subagents compositionally',
    promptGuidelines: [
      'ALWAYS `export default` a small summary — counts, key findings, short lists — never raw file contents.',
      'spawn never rejects: check result.ok and read result.error/result.kind on failure instead of try/catch around spawn.',
      'Fan out independent work with Promise.all([...]) and pass read-only tool allowlists (read, grep, find, ls) to research children.',
      'Wrap risky non-spawn steps (parsing, arithmetic on untrusted shapes) in try/catch — a thrown error fails the whole run.',
      'Every spawn() must declare its output contract: pass outputSchema for structured data (validated; lands in result.data) or text:true for raw text. A spawn with NEITHER throws immediately — it does not return unparsed text.',
      'Prefer runWorkflow over hand-rolled Promise.all when stages depend on each other, need gates/retries, or edit the working tree.',
      'Use log(...) for progress notes; they come back in the result details.',
      'Do not attempt imports — the snippet is bundled standalone and only spawn/runWorkflow/log are available.',
      'Never write busy-wait or long synchronous loops — they block the host event loop and can freeze the session (the timeout cannot preempt synchronous JS).',
    ],
    parameters: Type.Object({
      code: Type.String({ description: 'TypeScript source. Must `export default` the result.' }),
      label: Type.Optional(Type.String({ description: 'Short label for this run (result heading).' })),
      timeoutMs: Type.Optional(Type.Number({ description: 'Wall-clock cap. Default 10 min, max 30 min.' })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const label = params.label ?? 'codemode';
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      const outcome = await runCodemode({
        code: params.code,
        label,
        timeoutMs,
        cwd: ctx.cwd,
        externalSignal: signal ?? undefined,
      });
      return {
        content: [{ type: 'text' as const, text: outcome.text }],
        details: outcome.details,
      };
    },

    renderCall(args, theme, ctx) {
      const label = args.label?.trim() || 'codemode';
      const preview = codePreview(args.code);
      const header = `${fg(theme, 'toolTitle', theme.bold('Codemode'))} ${fg(theme, 'accent', label)}`;
      const meta = fg(theme, 'dim', `${preview.line} · ${preview.count} ${preview.count === 1 ? 'line' : 'lines'}`);
      const body = `${header}\n${branchLine(theme, meta)}`;

      if (!ctx?.isPartial) {
        clearSpinner(ctx);
        return makeText(ctx?.lastComponent, `${fg(theme, 'success', '✓')} ${body}`);
      }
      return makeText(ctx.lastComponent, `${spinnerDot(theme, ensureSpinner(ctx))}${body}`);
    },

    renderResult(result, options, theme, ctx) {
      const details = result.details as CodemodeDetails | undefined;
      const expanded = options?.expanded ?? false;
      const content = result.content[0];
      const fullText = content?.type === 'text' ? content.text : '';

      // No details — plain text fallback
      if (!details) {
        return makeText(ctx?.lastComponent, fullText || '(no output)');
      }

      const logs = details.logs ?? [];
      const label = fg(theme, 'accent', details.label);
      const duration = fg(theme, 'dim', formatDuration(details.durationMs));

      // ── Error state ──────────────────────────────────────────────
      if (details.error) {
        const header = `${fg(theme, 'error', '✗')} ${label} ${duration}`;
        const firstLine = details.error.split('\n')[0] ?? details.error;
        if (!expanded) {
          const lines = [header, `${branchLine(theme, fg(theme, 'error', firstLine))}${expandHint(theme)}`];
          return makeText(ctx?.lastComponent, lines.join('\n'));
        }
        const lines = [header, branchLine(theme, fg(theme, 'error', firstLine))];
        if (details.stack) {
          for (const line of details.stack.split('\n')) lines.push(indentLine(fg(theme, 'dim', line)));
        }
        appendLogTree(lines, logs, theme);
        return makeText(ctx?.lastComponent, lines.join('\n'));
      }

      // ── Success ──────────────────────────────────────────────────
      const header = `${fg(theme, 'success', '✓')} ${label} ${duration}`;
      const resultLines = fullText.split('\n');

      // Collapsed: first ~10 lines + dim overflow marker
      if (!expanded) {
        const shown = resultLines.slice(0, RESULT_PREVIEW_LINES);
        const remaining = resultLines.length - shown.length;
        const lines = [header];
        shown.forEach((line, i) => lines.push(i === 0 ? branchLine(theme, line) : indentLine(line)));
        if (remaining > 0) {
          lines.push(`${indentLine(fg(theme, 'dim', `+${remaining} more lines`))}${expandHint(theme)}`);
        } else if (logs.length > 0) {
          lines[0] = `${header}${expandHint(theme)}`;
        }
        return makeText(ctx?.lastComponent, lines.join('\n'));
      }

      // Expanded: full result + captured logs as an indented tree section
      const lines = [header];
      resultLines.forEach((line, i) => lines.push(i === 0 ? branchLine(theme, line) : indentLine(line)));
      appendLogTree(lines, logs, theme);
      return makeText(ctx?.lastComponent, lines.join('\n'));
    },
  });

  // ── `=` console prefix ─────────────────────────────────────────────
  // `=<snippet>` at position zero runs the snippet through the codemode
  // runtime inline, devtools-console style. The result renders as a
  // collapsible custom entry (toggled with the same `app.tools.expand` key
  // as tool output), the returned value binds to the next $N for later
  // console snippets, and the run is persisted as a session custom entry.
  // `{ action: "handled" }` is the documented interception mechanism — it
  // skips the agent entirely. Only the TUI editor prefix is intercepted;
  // extension-injected messages and non-tui modes pass through.
  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension' || ctx.mode !== 'tui') return { action: 'continue' };
    const stripped = event.text.trimStart();
    if (!stripped.startsWith('=') || stripped.length <= 1) return { action: 'continue' };
    const code = event.text.slice(event.text.indexOf('=') + 1);
    ctx.ui.setStatus('codemode', 'running console…');
    let outcome: CodemodeOutcome;
    try {
      outcome = await runCodemode({
        code,
        label: 'console',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        cwd: ctx.cwd,
        externalSignal: ctx.signal ?? undefined,
        bindResult: true,
      });
    } finally {
      ctx.ui.setStatus('codemode', undefined);
    }
    const n = outcome.boundN ?? sessionResults.length + 1;
    pi.appendEntry<ConsoleEntryData>(CONSOLE_TYPE, {
      n,
      label: 'console',
      code,
      text: outcome.text,
      details: outcome.details,
      value: outcome.value,
      ts: Date.now(),
    });
    return { action: 'handled' };
  });

  // ── `/cx` named snippets ──────────────────────────────────────────
  // Named codemode snippets as plain TS/JS files in
  // ~/.pi/agent/snippets/ (global) and .pi/snippets/ (project, trusted
  // only), mirroring pi's prompt-template discovery. This is a directory
  // convention ONLY — no registry, no index, no config keys. The registry is
  // `ls`; the package manager is git; the search engine is grep. Files are
  // read on demand, so /reload needs no snippet-specific wiring.
  function snippetDirs(cwd: string, trusted: boolean): string[] {
    const dirs = [path.join(getAgentDir(), 'snippets')];
    if (trusted) dirs.push(path.join(cwd, CONFIG_DIR_NAME, 'snippets'));
    return dirs;
  }

  function findSnippet(name: string, cwd: string, trusted: boolean): string | undefined {
    // Snippet names are bare file stems — never a path (defends against
    // `/cx ../../foo` escaping the snippets dirs).
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) return undefined;
    for (const dir of snippetDirs(cwd, trusted)) {
      for (const ext of ['.ts', '.js'] as const) {
        const f = path.join(dir, `${name}${ext}`);
        try {
          if (fs.statSync(f).isFile()) return f;
        } catch {
          // not present — try next candidate
        }
      }
    }
    return undefined;
  }

  function listGlobalSnippets(): { name: string; description?: string }[] {
    const dir = path.join(getAgentDir(), 'snippets');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'));
    } catch {
      return [];
    }
    return files.map((f) => {
      const name = f.replace(/\.(ts|js)$/, '');
      const item: { name: string; description?: string } = { name };
      try {
        const { frontmatter } = parseFrontmatter<{ description?: string }>(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (frontmatter.description) item.description = frontmatter.description;
      } catch {
        // best-effort description
      }
      return item;
    });
  }

  // `{{args}}` (all args), `{{@}}` (alias), `{{N}}` (positional, 1-indexed),
  // `{{N:-default}}` (positional with default). Unknown `{{...}}` is left
  // intact so authors can see typos.
  function substituteArgs(body: string, args: string[]): string {
    return body.replace(/\{\{([^}]+)\}\}/g, (whole, expr: string) => {
      const e = expr.trim();
      if (e === 'args' || e === '@') return args.join(' ');
      const m = /^(\d+)(?::-([\s\S]*))?$/.exec(e);
      if (m) {
        const idx = Number(m[1]) - 1;
        const val = args[idx];
        if (val !== undefined && val !== '') return val;
        return m[2] ?? '';
      }
      return whole;
    });
  }

  pi.registerCommand('cx', {
    description: 'Run a named codemode snippet (from ~/.pi/agent/snippets or .pi/snippets)',
    getArgumentCompletions: (argumentPrefix) => {
      // First token = snippet name; complete from the global snippets dir on
      // demand (the registry is `ls`). Once a name is chosen, offer no arg
      // completion — snippet authors define their own arg shapes.
      if (argumentPrefix.includes(' ')) return null;
      const prefix = argumentPrefix.trim();
      const all = listGlobalSnippets().filter((s) => s.name.startsWith(prefix));
      if (all.length === 0) return null;
      return all.map((s) => ({
        value: s.name,
        label: s.name,
        ...(s.description ? { description: s.description } : {}),
      }));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const name = parts[0];
      if (!name) {
        ctx.ui.notify('Usage: /cx <name> [args...]', 'warning');
        return;
      }
      const argList = parts.slice(1);
      const file = findSnippet(name, ctx.cwd, ctx.isProjectTrusted());
      if (!file) {
        ctx.ui.notify(`No codemode snippet '${name}' in ~/.pi/agent/snippets or ${CONFIG_DIR_NAME}/snippets`, 'error');
        return;
      }
      let body: string;
      try {
        body = parseFrontmatter<{ description?: string }>(fs.readFileSync(file, 'utf8')).body;
      } catch (err) {
        ctx.ui.notify(`Failed to read snippet: ${err instanceof Error ? err.message : String(err)}`, 'error');
        return;
      }
      const code = substituteArgs(body, argList);
      ctx.ui.setStatus('codemode', `running ${name}…`);
      let outcome: CodemodeOutcome;
      try {
        outcome = await runCodemode({
          code,
          label: name,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          cwd: ctx.cwd,
          externalSignal: ctx.signal ?? undefined,
          bindResult: true,
        });
      } finally {
        ctx.ui.setStatus('codemode', undefined);
      }
      const n = outcome.boundN ?? sessionResults.length + 1;
      pi.appendEntry<ConsoleEntryData>(CONSOLE_TYPE, {
        n,
        label: name,
        code,
        text: outcome.text,
        details: outcome.details,
        value: outcome.value,
        ts: Date.now(),
      });
    },
  });

  // ── Console entry renderer (collapsible) ─────────────────────────
  // Mirrors the tool's renderResult: ✓/✗ header with label + #N slot +
  // duration, preview lines collapsed behind `app.tools.expand`, captured
  // logs as an indented tree when expanded. Custom entries persist to the
  // session JSONL but never enter LLM context.
  pi.registerEntryRenderer<ConsoleEntryData>(CONSOLE_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data ?? {
      n: 0,
      label: 'console',
      code: '',
      text: '',
      details: { label: 'console', logs: [], durationMs: 0 },
      value: undefined,
      ts: 0,
    };
    const d = data.details;
    const logs = d?.logs ?? [];
    const label = fg(theme, 'accent', data.label);
    const nTag = d?.error ? '' : ` ${fg(theme, 'dim', `#$${data.n}`)}`;
    const duration = fg(theme, 'dim', formatDuration(d?.durationMs));
    let lines: string[];

    if (d?.error) {
      const header = `${fg(theme, 'error', '✗')} ${label}${nTag} ${duration}`;
      const firstLine = d.error.split('\n')[0] ?? d.error;
      if (!expanded) {
        lines = [header, `${branchLine(theme, fg(theme, 'error', firstLine))}${expandHint(theme)}`];
      } else {
        lines = [header, branchLine(theme, fg(theme, 'error', firstLine))];
        if (d.stack) {
          for (const line of d.stack.split('\n')) lines.push(indentLine(fg(theme, 'dim', line)));
        }
        appendLogTree(lines, logs, theme);
      }
      return makeText(undefined, lines.join('\n'));
    }

    const header = `${fg(theme, 'success', '✓')} ${label}${nTag} ${duration}`;
    const resultLines = (data.text ?? '').split('\n');
    if (!expanded) {
      const shown = resultLines.slice(0, RESULT_PREVIEW_LINES);
      const remaining = resultLines.length - shown.length;
      lines = [header];
      shown.forEach((line, i) => lines.push(i === 0 ? branchLine(theme, line) : indentLine(line)));
      if (remaining > 0) {
        lines.push(`${indentLine(fg(theme, 'dim', `+${remaining} more lines`))}${expandHint(theme)}`);
      } else if (logs.length > 0) {
        lines[0] = `${header}${expandHint(theme)}`;
      }
      return makeText(undefined, lines.join('\n'));
    }
    lines = [header];
    resultLines.forEach((line, i) => lines.push(i === 0 ? branchLine(theme, line) : indentLine(line)));
    appendLogTree(lines, logs, theme);
    return makeText(undefined, lines.join('\n'));
  });
}
