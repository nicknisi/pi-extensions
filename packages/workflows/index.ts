/**
 * @nicknisi/pi-workflows — the model-facing front door to the first-party
 * workflow engine.
 *
 * One `workflow` tool with actions: run (inline JS script OR a saved workflow
 * file name), list, status (runId), stop (runId). `run` compiles the script in
 * a node:vm context exactly like codemode compiles its snippets — `export const
 * meta =` is rewritten so the vm compiles, the body is wrapped in an async
 * function so a top-level `return` works, and meta.name/description surface in
 * the result. Injected globals: agent, parallel, pipeline, phase, log, args,
 * budget, cwd — the contract the old third-party tool's scripts were written
 * against, so existing scripts run unchanged.
 *
 * Saved workflows are plain files: ~/.pi/agent/workflows/*.js (global) and
 * .pi/workflows/*.js (project, trusted-only). The registry is `ls` — no
 * database, no manifest.
 *
 * Runs are visible: agent() spawns through @nicknisi/pi-shared's subagent
 * runtime (namespace 'workflows'), so child spawns appear in the fleet radar
 * from @nicknisi/pi-subagents. status/stop read from / cancel via the same
 * runtime's run records — no parallel store.
 *
 * The platform story: subagents runtime + codemode VM + shared/workflow.ts
 * engine + this tool = the workflow platform; the third-party
 * @quintinshaw/pi-dynamic-workflows engine is being evicted.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  createSubagentRuntime,
  readRunArtifacts,
  sweepRunArtifactsOnce,
  type RunArtifact,
  type SpawnOptions,
  type SpawnResult,
  type SubagentRuntime,
} from '@nicknisi/pi-shared';
import { Type } from 'typebox';
import { runScript, type EngineSpawnFn, type EngineSpawnOptions, type RunScriptResult } from './engine.js';

const ARTIFACTS_ROOT = path.join(getAgentDir(), 'subagent-runs');
const NAMESPACE = 'workflows';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RESULT_CHARS = 16 * 1024;
const MAX_LOG_CHARS = 2000;

// ── Live runId → AbortController, so `stop` can cancel in-flight spawns. ──
// Mirrors @nicknisi/pi-subagents' cascading-cancellation registry. Each
// agent() call spawns detached and registers its controller here; stop(runId)
// aborts it. Runs from other hosts show up via readRunArtifacts but are not
// cancellable here (they belong to a different process).
// Scoped per factory invocation (session) — two concurrent sessions in one
// process must never share (or cross-abort) each other's runs.
type Cancellables = Map<string, AbortController>;

function spawnCancellable(
  cancellables: Cancellables,
  runtime: SubagentRuntime,
  opts: SpawnOptions,
  externalSignal: AbortSignal | undefined,
): Promise<SpawnResult> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const { runId, done } = runtime.spawnDetached({ ...opts, signal: controller.signal });
  cancellables.set(runId, controller);
  void done.finally(() => {
    cancellables.delete(runId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  });
  return Object.assign(done, { runId }) as Promise<SpawnResult>;
}

function makeSpawnFn(
  cancellables: Cancellables,
  runtime: SubagentRuntime,
  cwd: string,
  externalSignal: AbortSignal | undefined,
): EngineSpawnFn {
  return async (opts: EngineSpawnOptions): Promise<SpawnResult> => {
    const spawnOpts: SpawnOptions = {
      prompt: opts.prompt,
      cwd,
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.outputSchema !== undefined ? { outputSchema: opts.outputSchema as never } : {}),
    };
    // Default children to read-only, matching codemode/dispatch; pi's own
    // default (read/bash/edit/write) would apply otherwise.
    if (opts.tools !== undefined) spawnOpts.tools = opts.tools;
    else spawnOpts.tools = ['read', 'grep', 'find', 'ls'];
    return spawnCancellable(cancellables, runtime, spawnOpts, externalSignal);
  };
}

// ── Saved-workflow discovery ──────────────────────────────────────────────
// Directory convention ONLY — no registry, no index, no config keys. The
// registry is `ls`; the package manager is git; the search engine is grep.

function workflowDirs(cwd: string, trusted: boolean): string[] {
  const dirs = [path.join(getAgentDir(), 'workflows')];
  if (trusted) dirs.push(path.join(cwd, CONFIG_DIR_NAME, 'workflows'));
  return dirs;
}

/** Bare file stems only — never a path (defends against `../` escaping). */
function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

export function findWorkflowFile(name: string, cwd: string, trusted: boolean): string | undefined {
  if (!isValidName(name)) return undefined;
  for (const dir of workflowDirs(cwd, trusted)) {
    const f = path.join(dir, `${name}.js`);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      // not present — try next dir
    }
  }
  return undefined;
}

export interface SavedWorkflow {
  name: string;
  scope: 'global' | 'project';
  description?: string;
}

export function listWorkflows(cwd: string, trusted: boolean): SavedWorkflow[] {
  const out: SavedWorkflow[] = [];
  const seen = new Set<string>();
  const dirs = workflowDirs(cwd, trusted);
  const scopes: Array<'global' | 'project'> = ['global', 'project'];
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    const scope = scopes[i]!;
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    } catch {
      continue;
    }
    for (const f of files) {
      const name = f.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const item: SavedWorkflow = { name, scope };
      try {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        const m = /\{\s*name:\s*['"`]([^'"`]+)['"`][^}]*description:\s*['"`]([^'"`]+)['"`]/.exec(src);
        if (m) item.description = m[2]!;
      } catch {
        // best-effort description
      }
      out.push(item);
    }
  }
  return out;
}

// ── Formatting helpers ────────────────────────────────────────────────────

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

function formatRun(run: RunArtifact): string {
  const id = run.runId.slice(0, 8);
  const ns = run.namespace;
  const status = run.status;
  const agent = run.agent ? ` ${run.agent}` : '';
  const model = run.model ? ` ${run.model}` : '';
  const preview = (run.promptPreview ?? '').replace(/\s+/g, ' ').trim();
  const tokens = run.usage ? ` · ${run.usage.totalTokens} tok` : '';
  const dur = run.endedAt ? ` · ${Math.round((run.endedAt - run.startedAt) / 1000)}s` : '';
  let line = `${id} [${ns}]${agent}${model} — ${status}${tokens}${dur}`;
  if (run.error) line += `\n  error: ${truncate(run.error, 200)}`;
  if (preview) line += `\n  ${truncate(preview, 120)}`;
  return line;
}

function formatRunResult(result: RunScriptResult, label: string): string {
  const header = `✓ ${label}${result.meta?.name ? ` — ${result.meta.name}` : ''} (${Math.round(result.durationMs / 1000)}s)`;
  const desc = result.meta?.description ? `\n${result.meta.description}` : '';
  const budget = result.usage.totalTokens > 0 ? `\nbudget: spent ${result.usage.totalTokens} tok` : '';
  const body = `\n${formatValue(result.value)}`;
  const logsBlock =
    result.logs.length > 0
      ? `\n\nlogs (${result.logs.length}):\n${result.logs.map((l) => `  ${truncate(l, MAX_LOG_CHARS)}`).join('\n')}`
      : '';
  return `${header}${desc}${budget}${body}${logsBlock}`;
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function workflows(pi: ExtensionAPI): void {
  const cancellables: Cancellables = new Map();
  const runtime = createSubagentRuntime({ namespace: NAMESPACE, artifactsDir: ARTIFACTS_ROOT });
  sweepRunArtifactsOnce(ARTIFACTS_ROOT);

  pi.registerTool({
    name: 'workflow',
    label: 'Workflow',
    description: [
      'Run a JavaScript workflow script that orchestrates subagents over the first-party runtime,',
      "or manage runs. Actions: 'run' (compile a script in a vm and execute it with injected",
      'globals), "list" (saved workflow files), "status" (a run record by runId), "stop" (cancel a',
      "run by runId). For 'run', pass EITHER `script` (inline JS) OR `name` (a saved workflow file",
      'stem from ~/.pi/agent/workflows/*.js or .pi/workflows/*.js). Optional `args` (any JSON value)',
      "is passed in as the script's `args` global.",
      '',
      'Script contract — injected globals: agent(prompt, opts), parallel(thunks),',
      'pipeline(items, ...stages), phase(name), log(...args), args, budget ({total, spent,',
      "remaining}), cwd. The script's FIRST statement SHOULD be `export const meta = { name,",
      'description }` (rewritten so the vm compiles; meta.name/description surface in the result).',
      'The script returns a value via a trailing expression or a top-level `return` (the body is',
      'wrapped in an async function).',
      '',
      'agent() opts: model, tools (default read-only [read, grep, find, ls]), label, systemPrompt,',
      'schema (validated; lands in result.data), effort (thinking level), timeoutMs, maxTurns,',
      'agentType (accepted but ignored — no agent-type registry; resolve systemPrompt in the',
      'script). agent() throws `${kind}: ${error}` on failure — wrap with a safeAgent that returns',
      '{ ok, value, error } so a failure inside parallel() does not collapse the wave.',
      '',
      'Runs are visible: every agent() spawn is a child in the subagent fleet (use the `fleet`',
      'tool / `/fleet` from @nicknisi/pi-subagents, or `status`/`stop` here). The script itself',
      'executes in the host process with full Node access — the same trust boundary as the bash',
      'tool. Keep the returned value small: summaries, counts, key findings — never raw file dumps.',
    ].join(' '),
    promptSnippet: 'Run a JS workflow script orchestrating subagents',
    promptGuidelines: [
      'The script body is wrapped in an async function — a top-level `return value` is the contract for the result.',
      'Lead with `export const meta = { name, description }` so the run is labeled in the result.',
      'agent() throws on failure; wrap it in a safeAgent() that returns { ok, value, error } so a failure inside parallel() reports which stage died instead of collapsing the wave to null.',
      'parallel(thunks) awaits Promise.all over zero-arg thunks — pass `() => agent(...)`, not `agent(...)`.',
      'Children default to read-only tools (read, grep, find, ls); pass `tools` explicitly for builders.',
      'Use log(...) for progress notes; they come back in the result details. phase(name) is a logging marker only.',
      'Keep the returned value small — summaries, counts, key findings — never raw file contents.',
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal('run'), Type.Literal('list'), Type.Literal('status'), Type.Literal('stop')], {
        description: 'Action: run | list | status | stop',
      }),
      script: Type.Optional(Type.String({ description: 'Inline JS workflow script (action: run).' })),
      name: Type.Optional(Type.String({ description: 'Saved workflow file stem (action: run).' })),
      args: Type.Optional(
        Type.Any({ description: "Any JSON value passed as the script's `args` global (action: run)." }),
      ),
      runId: Type.Optional(Type.String({ description: 'Run id (action: status | stop).' })),
      timeoutMs: Type.Optional(Type.Number({ description: 'Wall-clock cap for run. Default 10 min, max 30 min.' })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = params.action;

      if (action === 'list') {
        const items = listWorkflows(ctx.cwd, ctx.isProjectTrusted());
        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No saved workflows. Drop .js files in ~/.pi/agent/workflows/ or .pi/workflows/.',
              },
            ],
            details: {},
          };
        }
        const lines = items.map((w) => {
          const tail = w.description ? ` — ${w.description}` : '';
          return `  ${w.name} [${w.scope}]${tail}`;
        });
        return {
          content: [{ type: 'text' as const, text: `Saved workflows (${items.length}):\n${lines.join('\n')}` }],
          details: { count: items.length },
        };
      }

      if (action === 'status') {
        const runId = params.runId;
        if (!runId) {
          return { content: [{ type: 'text' as const, text: 'status requires runId.' }], details: {} };
        }
        const record = findRun(runtime, runId);
        if (!record) {
          return {
            content: [{ type: 'text' as const, text: `No run '${runId.slice(0, 8)}' (full or prefix).` }],
            details: {},
          };
        }
        return {
          content: [{ type: 'text' as const, text: formatRun(record) }],
          details: { runId: record.runId, status: record.status },
        };
      }

      if (action === 'stop') {
        const runId = params.runId;
        if (!runId) {
          return { content: [{ type: 'text' as const, text: 'stop requires runId.' }], details: {} };
        }
        const controller = resolveCancellable(cancellables, runtime, runId);
        if (!controller) {
          const record = findRun(runtime, runId);
          const msg =
            record && (record.status === 'running' || record.status === 'queued')
              ? `Run ${runId.slice(0, 8)} isn't cancellable from here (it belongs to a different host process).`
              : `Run ${runId.slice(0, 8)} already finished.`;
          return { content: [{ type: 'text' as const, text: msg }], details: {} };
        }
        controller.abort();
        return {
          content: [{ type: 'text' as const, text: `Cancelled run ${runId.slice(0, 8)}.` }],
          details: { runId },
        };
      }

      // action === 'run'
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      let src: string;
      let label: string;
      if (params.name) {
        const file = findWorkflowFile(params.name, ctx.cwd, ctx.isProjectTrusted());
        if (!file) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No workflow '${params.name}' in ~/.pi/agent/workflows or ${CONFIG_DIR_NAME}/workflows.`,
              },
            ],
            details: {},
          };
        }
        try {
          src = fs.readFileSync(file, 'utf8');
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to read workflow: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: {},
          };
        }
        label = params.name;
      } else if (params.script) {
        src = params.script;
        label = 'inline';
      } else {
        return {
          content: [
            { type: 'text' as const, text: 'run requires either `script` (inline JS) or `name` (saved workflow).' },
          ],
          details: {},
        };
      }

      // One controller for BOTH abort sources: the tool's signal AND the
      // timeout. spawnCancellable wires it into every child spawn, so firing
      // it actually cancels in-flight work (previously the timeout controller
      // was connected to nothing — dead code).
      const controller = new AbortController();
      let timedOut = false;
      const onToolAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onToolAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const spawnFn = makeSpawnFn(cancellables, runtime, ctx.cwd, controller.signal);
      const timeoutPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () =>
            reject(
              new Error(
                timedOut
                  ? `Timed out after ${timeoutMs}ms (in-flight subagents were aborted)`
                  : 'Aborted by the host session',
              ),
            ),
          { once: true },
        );
      });
      try {
        const result = await Promise.race([
          runScript({
            script: src,
            args: params.args,
            spawn: spawnFn,
            cwd: ctx.cwd,
            onLog: () => {},
          }),
          timeoutPromise,
        ]);
        const text = formatRunResult(result, label);
        return {
          content: [{ type: 'text' as const, text }],
          details: {
            label,
            meta: result.meta,
            logs: result.logs,
            usage: result.usage,
            durationMs: result.durationMs,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `${label} failed:\n\n${msg}` }],
          details: { label, error: msg },
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onToolAbort);
      }
    },
  });

  // ── /wf — thin human-facing wrapper ───────────────────────────────────
  pi.registerCommand('wf', {
    description:
      'Workflows: /wf list | /wf run <name> [argsJson] | /wf status <runId> | /wf stop <runId>. Saved workflows live in ~/.pi/agent/workflows/*.js (global) and .pi/workflows/*.js (project, trusted only).',
    getArgumentCompletions: (argumentPrefix) => {
      if (argumentPrefix.includes(' ')) return null;
      const prefix = argumentPrefix.trim();
      const subs = ['list', 'run', 'status', 'stop'].filter((s) => s.startsWith(prefix));
      if (subs.length === 0) return null;
      return subs.map((s) => ({ value: s + ' ', label: s }));
    },
    handler: async (args, ctx) => {
      await cmdWf(args, ctx, runtime, cancellables);
    },
  });
}

// ── /wf handler (shared, typed against the runtime) ───────────────────────

async function cmdWf(
  args: string,
  ctx: ExtensionCommandContext,
  runtime: SubagentRuntime,
  cancellables: Cancellables,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];

  if (!sub || sub === 'list') {
    const items = listWorkflows(ctx.cwd, ctx.isProjectTrusted());
    if (items.length === 0) {
      ctx.ui.notify('No saved workflows. Drop .js files in ~/.pi/agent/workflows/ or .pi/workflows/.', 'info');
      return;
    }
    const lines = items.map((w) => `  ${w.name} [${w.scope}]${w.description ? ` — ${w.description}` : ''}`);
    ctx.ui.notify(`Saved workflows (${items.length}):\n${lines.join('\n')}`, 'info');
    return;
  }

  if (sub === 'run') {
    const name = parts[1];
    if (!name) {
      ctx.ui.notify('Usage: /wf run <name> [argsJson]', 'warning');
      return;
    }
    const file = findWorkflowFile(name, ctx.cwd, ctx.isProjectTrusted());
    if (!file) {
      ctx.ui.notify(`No workflow '${name}' in ~/.pi/agent/workflows or ${CONFIG_DIR_NAME}/workflows`, 'error');
      return;
    }
    let src: string;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (err) {
      ctx.ui.notify(`Failed to read workflow: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    const argsJson = parts.slice(2).join(' ');
    let parsedArgs: unknown = undefined;
    if (argsJson) {
      try {
        parsedArgs = JSON.parse(argsJson);
      } catch {
        // Fall back to the raw string — many scripts treat args as a string.
        parsedArgs = argsJson;
      }
    }
    ctx.ui.setStatus('workflows', `running ${name}…`);
    try {
      const spawnFn = makeSpawnFn(cancellables, runtime, ctx.cwd, ctx.signal ?? undefined);
      const result = await runScript({ script: src, args: parsedArgs, spawn: spawnFn, cwd: ctx.cwd });
      ctx.ui.notify(formatRunResult(result, name), 'info');
    } catch (err) {
      ctx.ui.notify(`${name} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      ctx.ui.setStatus('workflows', undefined);
    }
    return;
  }

  if (sub === 'status') {
    const runId = parts[1];
    if (!runId) {
      ctx.ui.notify('Usage: /wf status <runId>', 'warning');
      return;
    }
    const record = findRun(runtime, runId);
    if (!record) {
      ctx.ui.notify(`No run '${runId.slice(0, 8)}' (full or prefix).`, 'warning');
      return;
    }
    ctx.ui.notify(formatRun(record), 'info');
    return;
  }

  if (sub === 'stop') {
    const runId = parts[1];
    if (!runId) {
      ctx.ui.notify('Usage: /wf stop <runId>', 'warning');
      return;
    }
    const controller = resolveCancellable(cancellables, runtime, runId);
    if (!controller) {
      const record = findRun(runtime, runId);
      ctx.ui.notify(
        record && (record.status === 'running' || record.status === 'queued')
          ? `Run ${runId.slice(0, 8)} isn't cancellable from here (different host process).`
          : `Run ${runId.slice(0, 8)} already finished.`,
        'warning',
      );
      return;
    }
    controller.abort();
    ctx.ui.notify(`Cancelled run ${runId.slice(0, 8)}`, 'info');
    return;
  }

  ctx.ui.notify('Usage: /wf list | /wf run <name> [argsJson] | /wf status <runId> | /wf stop <runId>', 'warning');
}

// ── Run lookup / cancellation resolution ──────────────────────────────────

/** Find a run by full id or unique 8-char prefix across live + persisted records. */
function findRun(runtime: SubagentRuntime, runId: string): RunArtifact | undefined {
  const live = runtime.listRuns() as RunArtifact[];
  const persisted = readRunArtifacts(ARTIFACTS_ROOT);
  const byId = new Map<string, RunArtifact>();
  for (const r of persisted) byId.set(r.runId, r);
  for (const r of live) byId.set(r.runId, { ...byId.get(r.runId), ...r });
  if (byId.has(runId)) return byId.get(runId);
  // Unique prefix match (>=8 chars) — defends against ambiguous short prefixes.
  if (runId.length >= 8) {
    const matches = [...byId.values()].filter((r) => r.runId.startsWith(runId));
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

/** Resolve a cancellable controller by full id or unique prefix. */
function resolveCancellable(
  cancellables: Cancellables,
  _runtime: SubagentRuntime,
  runId: string,
): AbortController | undefined {
  if (cancellables.has(runId)) return cancellables.get(runId);
  if (runId.length >= 8) {
    const matches = [...cancellables.entries()].filter(([id]) => id.startsWith(runId));
    if (matches.length === 1) return matches[0]![1];
  }
  return undefined;
}

// Exported for typechecking against the ExtensionContext used by the tool.
export type { ExtensionContext };
