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
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  ARTIFACT_RETENTION_MS,
  createSubagentRuntime,
  subagentsDir,
  readRunArtifacts,
  sweepRunArtifactsOnce,
  type RunArtifact,
  type SpawnOptions,
  type SpawnResult,
  type SubagentRuntime,
  declareUnlessSearchable,
} from '@nicknisi/pi-shared';
import { Type } from 'typebox';
import type { EngineSpawnFn, EngineSpawnOptions, EngineSpawnResult } from './engine.js';
import {
  formatRunLine,
  formatRunResult,
  formatRunStatus,
  readStoredRun,
  startRun,
  sweepWorkflowRuns,
  type WorkflowRun,
  type WorkflowRuns,
} from './runs.js';
import {
  hasUltracodeKeyword,
  ULTRACODE_GUIDANCE,
  ULTRACODE_KEYWORD_GUIDANCE,
  ULTRACODE_SECTION,
  ultracodeDefault,
} from './ultracode.js';
import { WorkflowsView, type ViewResult } from './view.js';

// Resolved at use: PI_SUBAGENTS_DIR (see @nicknisi/pi-shared) relocates every runtime write.
const artifactsRoot = () => subagentsDir('runs') ?? path.join(getAgentDir(), 'subagent-runs');
// Workflow run dirs (script, run.json, journal) for status and relaunch.
const workflowRunsRoot = () => subagentsDir('workflow-runs') ?? path.join(getAgentDir(), 'workflow-runs');
const NAMESPACE = 'workflows';

/**
 * Concurrent workflow agents: 16 by default, fewer on machines with fewer
 * CPUs; PI_WORKFLOW_MAX_CONCURRENT overrides (1–256).
 */
export function workflowMaxConcurrent(env: NodeJS.ProcessEnv = process.env, cpus = os.availableParallelism()): number {
  const raw = Number(env.PI_WORKFLOW_MAX_CONCURRENT);
  if (Number.isInteger(raw) && raw >= 1) return Math.min(raw, 256);
  return Math.max(1, Math.min(16, cpus));
}

/** Stall window for workflow agents: 5 minutes; PI_WORKFLOW_STALL_MS overrides (0 disables). */
export function workflowStallMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PI_WORKFLOW_STALL_MS);
  return env.PI_WORKFLOW_STALL_MS !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60 * 1000;
}

// ── Live runId → AbortController, so `stop` can cancel in-flight spawns. ──
// Mirrors @nicknisi/pi-subagents' cascading-cancellation registry. Each
// agent() call spawns detached and registers its controller here; stop(runId)
// aborts it. Runs from other hosts show up via readRunArtifacts but are not
// cancellable here (they belong to a different process).
// Scoped per factory invocation (session) — two concurrent sessions in one
// process must never share (or cross-abort) each other's runs.
type Cancellables = Map<string, AbortController>;

// ── Footer status ──────────────────────────────────────────────────────────

function refreshFooter(
  runs: WorkflowRuns,
  setStatus: ((id: string, text: string | undefined) => void) | undefined,
): void {
  if (!setStatus) return;
  const active = [...runs.values()].filter((r) => r.status === 'running');
  if (active.length === 0) return setStatus('workflows', undefined);
  if (active.length > 1) return setStatus('workflows', `wf ${active.length} runs · /workflows`);
  const run = active[0]!;
  const done = run.agents.filter((a) => a.status === 'done' || a.status === 'cached').length;
  const phase = run.phases.at(-1);
  setStatus(
    'workflows',
    `wf ${run.label} [${run.gate.paused ? 'paused' : 'running'}]${phase ? ` ${phase}` : ''} · ${done}/${run.agents.length}`,
  );
}

/** Resolve a workflow run id (full or unique prefix) among this session's runs. */
function findWorkflowRun(runs: WorkflowRuns, id: string): WorkflowRun | undefined {
  if (runs.has(id)) return runs.get(id);
  if (!id.startsWith('wf-') || id.length < 5) return undefined;
  const matches = [...runs.values()].filter((r) => r.id.startsWith(id));
  return matches.length === 1 ? matches[0] : undefined;
}

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

/** Prompt-cache hold for fan-outs: 5s by default; PI_WORKFLOW_PREFIX_STAGGER_MS overrides (0 disables). */
export function workflowStaggerMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PI_WORKFLOW_PREFIX_STAGGER_MS);
  return env.PI_WORKFLOW_PREFIX_STAGGER_MS !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

// Anthropic's default cache TTL is 5 minutes; treat a prefix as warm a bit less.
const PREFIX_WARM_MS = 4 * 60 * 1000;

/**
 * Siblings that share a prompt prefix (same model, effort, tools, system
 * prompt, schema) should read one cache write instead of each paying for
 * their own. The first agent with a cold prefix starts at once; matching
 * agents wait until its response starts (when the cache entry becomes
 * readable), at most `capMs`. A prefix used recently is warm: no wait.
 */
export function createPrefixStagger(capMs: number, now: () => number = Date.now) {
  const warming = new Map<string, Promise<void>>();
  const warmUntil = new Map<string, number>();
  return async function stagger<T>(key: string, start: (onResponseStart: () => void) => Promise<T>): Promise<T> {
    const markWarm = () => warmUntil.set(key, now() + PREFIX_WARM_MS);
    if (capMs <= 0 || (warmUntil.get(key) ?? 0) > now()) return start(markWarm);
    const pending = warming.get(key);
    if (pending) {
      await pending;
      return start(markWarm);
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = setTimeout(() => release(), capMs);
    warming.set(key, gate);
    void gate.then(() => {
      clearTimeout(timer);
      warming.delete(key);
    });
    try {
      return await start(() => {
        markWarm();
        release();
      });
    } finally {
      release();
    }
  };
}

function makeSpawnFn(
  cancellables: Cancellables,
  runtime: SubagentRuntime,
  cwd: string,
  ownerSession: string | undefined,
  externalSignal: AbortSignal | undefined,
  stagger: ReturnType<typeof createPrefixStagger> = createPrefixStagger(0),
): EngineSpawnFn {
  return async (opts: EngineSpawnOptions): Promise<EngineSpawnResult> => {
    const spawnOpts: SpawnOptions = {
      prompt: opts.prompt,
      cwd,
      ...(ownerSession !== undefined ? { ownerSession } : {}),
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.stallMs !== undefined ? { stallMs: opts.stallMs } : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.outputSchema !== undefined ? { outputSchema: opts.outputSchema as never } : {}),
      ...(opts.worktree === true ? { worktree: true } : {}),
    };
    // Default children to read-only, matching codemode/dispatch; pi's own
    // default (read/bash/edit/write) would apply otherwise.
    if (opts.tools !== undefined) spawnOpts.tools = opts.tools;
    else spawnOpts.tools = ['read', 'grep', 'find', 'ls'];
    // Stop the child when either the whole run or this one agent is stopped.
    const signal =
      externalSignal && opts.signal ? AbortSignal.any([externalSignal, opts.signal]) : (opts.signal ?? externalSignal);
    // Worktree agents each get their own cwd, so they never share a prefix.
    const prefix = JSON.stringify([
      spawnOpts.model,
      spawnOpts.thinkingLevel,
      spawnOpts.tools,
      spawnOpts.systemPrompt,
      spawnOpts.outputSchema,
    ]);
    const res = opts.worktree
      ? await spawnCancellable(cancellables, runtime, spawnOpts, signal)
      : await stagger(prefix, (onResponseStart) =>
          spawnCancellable(cancellables, runtime, { ...spawnOpts, onResponseStart }, signal),
        );
    // Surface the worktree `.patch` path (recorded on the run record after
    // settle) so workflow scripts can return it for the `/patches` apply flow.
    if (res.ok) {
      const record = runtime.listRuns().find((r) => r.runId === res.runId);
      const patchPath = record?.worktree?.patchPath;
      if (patchPath) {
        return { ok: true, text: res.text, data: res.data, usage: res.usage, runId: res.runId, patchPath };
      }
    }
    return res;
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

/** Write a run's script as a saved workflow. Returns the file path. */
export function saveWorkflowScript(script: string, name: string, dir: string): string {
  if (!isValidName(name)) throw new Error(`Invalid workflow name '${name}': use letters, digits, '-' or '_'.`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, script.endsWith('\n') ? script : `${script}\n`);
  return file;
}

// ── Formatting helpers ────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated at ${max} chars]`;
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

// ── Extension ─────────────────────────────────────────────────────────────

type TextResult = { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> };
const text = (t: string, details: Record<string, unknown> = {}): TextResult => ({
  content: [{ type: 'text' as const, text: t }],
  details,
});

interface RunRequest {
  script?: string | undefined;
  name?: string | undefined;
  args?: unknown;
  relaunch?: string | undefined;
}

/** Resolve what to run: a saved workflow, an inline script, or a relaunch. */
function resolveRunRequest(
  req: RunRequest,
  cwd: string,
  trusted: boolean,
  runs: WorkflowRuns,
): { script: string; args: unknown; label: string; relaunch?: string } | { error: string } {
  if (req.relaunch) {
    const id = findWorkflowRun(runs, req.relaunch)?.id ?? req.relaunch;
    if (runs.get(id)?.status === 'running') return { error: `Workflow ${id} is still running; stop it first.` };
    const stored = readStoredRun(workflowRunsRoot(), id);
    if (!stored) return { error: `No workflow run '${req.relaunch}' to relaunch.` };
    return {
      script: req.script ?? stored.script,
      args: req.args !== undefined ? req.args : stored.args,
      label: stored.label,
      relaunch: id,
    };
  }
  if (req.name) {
    const file = findWorkflowFile(req.name, cwd, trusted);
    if (!file) return { error: `No workflow '${req.name}' in ~/.pi/agent/workflows or ${CONFIG_DIR_NAME}/workflows.` };
    try {
      return { script: fs.readFileSync(file, 'utf8'), args: req.args, label: req.name };
    } catch (err) {
      return { error: `Failed to read workflow: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (req.script) return { script: req.script, args: req.args, label: 'inline' };
  return { error: 'run requires `script` (inline JS), `name` (saved workflow), or `relaunch` (a workflow run id).' };
}

export default function workflows(pi: ExtensionAPI): void {
  const cancellables: Cancellables = new Map();
  const runs: WorkflowRuns = new Map();
  // Children share the parent session's model registry and default model.
  let parentCtx: ExtensionContext | undefined;
  const runtime = createSubagentRuntime({
    namespace: NAMESPACE,
    maxConcurrent: workflowMaxConcurrent(),
    artifactsDir: artifactsRoot(),
    parent: () => parentCtx,
  });
  sweepRunArtifactsOnce(artifactsRoot());
  let swept = false;
  pi.on('session_start', (_event, ctx) => {
    parentCtx = ctx;
    if (!swept) {
      swept = true;
      sweepWorkflowRuns(workflowRunsRoot(), ARTIFACT_RETENTION_MS);
    }
  });
  pi.on('session_start', () => declareUnlessSearchable(pi, ['workflow']));
  // Saved workflows run as /<name>, like Claude Code's saved workflow commands.
  const savedCommands = new Set<string>();
  function registerSavedCommand(name: string, description: string | undefined): void {
    if (savedCommands.has(name)) return;
    if (pi.getCommands().some((c) => c.name === name)) return; // never shadow another command
    savedCommands.add(name);
    pi.registerCommand(name, {
      description: `Workflow: ${description ?? name} (saved workflow; arguments become \`args\`)`,
      handler: async (rawArgs, ctx) => {
        let args: unknown = undefined;
        if (rawArgs.trim()) {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = rawArgs.trim();
          }
        }
        const req = resolveRunRequest({ name, args }, ctx.cwd, ctx.isProjectTrusted(), runs);
        if ('error' in req) {
          ctx.ui.notify(req.error, 'error');
          return;
        }
        const run = launch(ctx, req, { onSettled: (r) => deliver(r, false) });
        ctx.ui.notify(`Started workflow ${run.id} (${name}). Watch it with /workflows.`, 'info');
      },
    });
  }
  pi.on('session_start', (_event, ctx) => {
    for (const w of listWorkflows(ctx.cwd, ctx.isProjectTrusted())) registerSavedCommand(w.name, w.description);
  });

  /** Ask for a name and location (unless given), then save a run's script as a workflow command. */
  async function saveRun(ctx: ExtensionContext, id: string, presetName?: string): Promise<void> {
    const run = findWorkflowRun(runs, id);
    const stored = readStoredRun(workflowRunsRoot(), run?.id ?? id);
    if (!stored) {
      ctx.ui.notify(`No workflow run '${id}' to save.`, 'error');
      return;
    }
    const suggested = (run?.meta?.name ?? stored.meta?.name ?? '').replace(/[^a-zA-Z0-9_-]+/g, '-');
    const name = presetName ?? (await ctx.ui.input('Save workflow as', suggested || 'my-workflow'))?.trim();
    if (!name) return;
    let dir = path.join(getAgentDir(), 'workflows');
    if (!presetName && ctx.isProjectTrusted()) {
      const project = `${CONFIG_DIR_NAME}/workflows/ in this project (shared with the repo)`;
      const choice = await ctx.ui.select('Save where?', [project, '~/.pi/agent/workflows/ (every project, only you)']);
      if (!choice) return;
      if (choice === project) dir = path.join(ctx.cwd, CONFIG_DIR_NAME, 'workflows');
    }
    if (
      fs.existsSync(path.join(dir, `${name}.js`)) &&
      !(await ctx.ui.confirm('Overwrite?', `${name}.js already exists.`))
    ) {
      return;
    }
    try {
      const file = saveWorkflowScript(stored.script, name, dir);
      registerSavedCommand(name, stored.meta?.description);
      ctx.ui.notify(`Saved ${file}. Run it with /${name} or /wf run ${name}.`, 'info');
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  // ── Ultracode: the model decides when a task warrants a workflow ──────
  pi.registerFlag('ultracode', {
    type: 'boolean',
    description: 'Start with ultracode on (workflows for every substantive task)',
  });
  let ultracode = false;
  let keywordTask = false;
  const ensureWorkflowTool = () => {
    const active = pi.getActiveTools();
    if (!active.includes('workflow')) pi.setActiveTools([...active, 'workflow']);
  };
  const ultracodeStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus('ultracode', ultracode ? 'ultracode' : undefined);
  };
  pi.on('session_start', (_event, ctx) => {
    ultracode = pi.getFlag('ultracode') === true || ultracodeDefault(getAgentDir());
    if (ultracode) ensureWorkflowTool();
    ultracodeStatus(ctx);
  });
  // The keyword only counts in a prompt a person typed (not print mode or extension-sent text).
  pi.on('input', (event, ctx) => {
    if (event.source !== 'extension' && (ctx.mode === 'tui' || ctx.mode === 'rpc') && hasUltracodeKeyword(event.text)) {
      keywordTask = true;
    }
    return { action: 'continue' };
  });
  pi.on('before_agent_start', (event) => {
    const { sections } = event.systemPromptOptions;
    if (ultracode) sections[ULTRACODE_SECTION] = ULTRACODE_GUIDANCE;
    else delete sections[ULTRACODE_SECTION];
    // Runs started by custom messages (e.g. a workflow result) never consume the keyword.
    if ((event as { messageType?: string }).messageType === 'custom' || !keywordTask) return;
    keywordTask = false;
    ensureWorkflowTool();
    return { message: { customType: 'workflows:ultracode', content: ULTRACODE_KEYWORD_GUIDANCE, display: false } };
  });
  pi.registerCommand('ultracode', {
    description: 'Toggle ultracode: plan a workflow for every substantive task this session (/ultracode on|off)',
    getArgumentCompletions: (prefix) =>
      ['on', 'off'].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== 'on' && arg !== 'off') {
        ctx.ui.notify('Usage: /ultracode [on|off]', 'warning');
        return;
      }
      ultracode = arg ? arg === 'on' : !ultracode;
      if (ultracode) ensureWorkflowTool();
      ultracodeStatus(ctx);
      ctx.ui.notify(
        ultracode
          ? 'Ultracode on: substantive tasks run as workflows. Each request uses more tokens and takes longer.'
          : 'Ultracode off.',
        'info',
      );
    },
  });

  pi.registerCommand('workflows', {
    description: 'Watch workflow runs: phases, agents, results. Enter open • p pause • x stop • r restart • s save',
    handler: async (args, ctx) => {
      if (runs.size === 0) {
        ctx.ui.notify('No workflow runs in this session.', 'info');
        return;
      }
      const initial = args.trim() ? findWorkflowRun(runs, args.trim())?.id : undefined;
      if (ctx.mode !== 'tui') {
        ctx.ui.notify(status(initial), 'info');
        return;
      }
      const result = await ctx.ui.custom<ViewResult>(
        (tui, theme, _kb, done) => new WorkflowsView(() => [...runs.values()], initial, tui, theme, done, footer),
        { overlay: true, overlayOptions: { width: '85%', maxHeight: '75%', anchor: 'center' } },
      );
      if (result?.save) await saveRun(ctx, result.save);
    },
  });

  // Background runs belong to the session: stop them when it ends.
  pi.on('session_shutdown', () => {
    for (const run of runs.values()) if (run.status === 'running') run.controller.abort();
  });

  const footer = () => refreshFooter(runs, parentCtx?.hasUI ? (id, t) => parentCtx?.ui.setStatus(id, t) : undefined);

  /** Start a run; `onSettled` fires once with the finished run. */
  function launch(
    ctx: ExtensionContext,
    req: { script: string; args: unknown; label: string; relaunch?: string | undefined },
    opts: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined; onSettled?: (run: WorkflowRun) => void },
  ): WorkflowRun {
    const ownerSession = ctx.sessionManager.getSessionFile();
    const run = startRun(runs, {
      root: workflowRunsRoot(),
      script: req.script,
      args: req.args,
      label: req.label,
      cwd: ctx.cwd,
      relaunch: req.relaunch,
      stallMs: workflowStallMs(),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      spawn: (runSignal) =>
        makeSpawnFn(cancellables, runtime, ctx.cwd, ownerSession, runSignal, createPrefixStagger(workflowStaggerMs())),
      ...(ctx.hasUI ? { ui: ctx.ui } : {}),
      onChange: footer,
    });
    footer();
    void run.done.then(() => {
      footer();
      try {
        opts.onSettled?.(run);
      } catch (err) {
        // sendMessage throws once the session is ending; a lost notice beats a crash.
        console.error(`[workflows] ${run.id} completion notice failed:`, err);
      }
    });
    return run;
  }

  /** Deliver a background run's result into the conversation. */
  function deliver(run: WorkflowRun, triggerTurn: boolean): void {
    pi.sendMessage(
      {
        customType: 'workflows:result',
        content: `Workflow ${formatRunResult(run)}`,
        display: true,
        details: { id: run.id, status: run.status },
      },
      triggerTurn ? { triggerTurn: true, deliverAs: 'followUp' } : {},
    );
  }

  function pauseOrResume(action: 'pause' | 'resume', id: string | undefined): string {
    const targets = id
      ? [findWorkflowRun(runs, id)].filter((r): r is WorkflowRun => r !== undefined)
      : [...runs.values()].filter((r) => r.status === 'running');
    if (id && targets.length === 0) return `No workflow run '${id}' in this session.`;
    if (targets.length === 0) return 'No active workflow run in this session.';
    for (const run of targets) {
      if (action === 'pause') run.gate.pause();
      else run.gate.resume();
    }
    footer();
    return `${action === 'pause' ? 'Paused' : 'Resumed'} ${targets.map((r) => r.id).join(', ')}.`;
  }

  function status(id: string | undefined): string {
    if (!id) {
      const all = [...runs.values()];
      return all.length === 0
        ? 'No workflow runs in this session.'
        : `Workflow runs (${all.length}):\n${all.map((r) => `  ${formatRunLine(r)}`).join('\n')}`;
    }
    const run = findWorkflowRun(runs, id);
    if (run) return run.status === 'running' ? formatRunStatus(run) : `${formatRunStatus(run)}\n\n${run.summary ?? ''}`;
    const record = findRun(runtime, id);
    return record ? formatRun(record) : `No run '${id.slice(0, 11)}' (workflow id, agent run id, or prefix).`;
  }

  function stop(id: string): string {
    const run = findWorkflowRun(runs, id);
    if (run) {
      if (run.status !== 'running') return `Workflow ${run.id} already ${run.status}.`;
      run.controller.abort();
      return `Stopping workflow ${run.id}. Relaunch it later with relaunch=${run.id}.`;
    }
    const controller = resolveCancellable(cancellables, runtime, id);
    if (controller) {
      controller.abort();
      return `Cancelled agent run ${id.slice(0, 8)}.`;
    }
    const record = findRun(runtime, id);
    return record && (record.status === 'running' || record.status === 'queued')
      ? `Run ${id.slice(0, 8)} isn't cancellable from here (it belongs to a different host process).`
      : `No running workflow or agent '${id.slice(0, 11)}'.`;
  }

  pi.registerTool({
    name: 'workflow',
    label: 'Workflow',
    exposure: 'deferred',
    // Scripts run host-process JS and child agents may edit files or reach the network.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description: [
      'Run a JavaScript workflow script that orchestrates many subagents, or manage runs.',
      'Runs start in the background and return a workflow id (wf-xxxxxxxx) at once; the result',
      'arrives later as a message, so end your turn after starting one unless there is other work.',
      'Pass background: false only when you need the value inside this tool call (e.g. from codemode).',
      'Actions: run, list (saved workflow files), status (runId = workflow id or agent run id; omit',
      'for all runs), stop (runId), pause/resume (runId optional; hold runs before their next agent).',
      'For run, pass ONE of script (inline JS), name (a saved file stem from ~/.pi/agent/workflows/*.js',
      'or .pi/workflows/*.js), or relaunch (a stopped/failed workflow id: completed agents replay',
      'from its journal; pass script too to relaunch an edited version), plus optional args (any JSON,',
      'exposed as the `args` global). Prefer a saved workflow when one fits.',
      'Script contract: the body is wrapped in an async function, so return the result with a',
      'top-level `return`. Keep it small (summaries, counts, findings; never raw file contents). The',
      'FIRST statement should be `export const meta = { name, description }`. Injected globals:',
      'agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(name) (groups the agents',
      'that follow in /workflows), log(...args), args, budget ({ total, spent, remaining }), cwd,',
      'checkpoint(label?), ask(question, options?). Keep scripts deterministic (no Date.now()/Math.random()',
      'in prompts) so relaunch can replay them.',
      'agent() opts: model, tools (default read-only [read, grep, find, ls]; pass tools explicitly for',
      'builders), label, systemPrompt, schema (the agent is told it; agent() returns parsed data,',
      'otherwise text), effort (thinking level), timeoutMs, stallMs (restart after this long without',
      'output; default 5 min), maxTurns, worktree (when a patch is produced, agent() returns',
      '{ value, patchPath, runId }). A failed agent() becomes null inside parallel()/pipeline() (logged;',
      'later pipeline stages skip it); awaited directly it throws `${kind}: ${error}`.',
      'parallel(thunks) takes zero-arg thunks: pass () => agent(...), not agent(...). Up to',
      `${workflowMaxConcurrent()} agents run at once; at most 1000 agents per run and 4096 items per call.`,
      'checkpoint(label?) gates the run on a human confirm (dismiss or reject throws and stops the',
      'run). ask(question, options?) asks the human mid-run: select when options are given, yes/no',
      'otherwise, undefined when dismissed. Use them before destructive or expensive steps.',
      'The script runs in the host process with full Node access, the same trust boundary as bash.',
    ].join(' '),
    promptSnippet: 'Run a JS workflow script orchestrating subagents',
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('run'),
          Type.Literal('list'),
          Type.Literal('status'),
          Type.Literal('stop'),
          Type.Literal('pause'),
          Type.Literal('resume'),
        ],
        { description: 'Action: run | list | status | stop | pause | resume' },
      ),
      script: Type.Optional(Type.String({ description: 'Inline JS workflow script (action: run).' })),
      name: Type.Optional(Type.String({ description: 'Saved workflow file stem (action: run).' })),
      relaunch: Type.Optional(
        Type.String({ description: 'Workflow id to relaunch; completed agents replay (action: run).' }),
      ),
      args: Type.Optional(
        Type.Any({ description: "Any JSON value passed as the script's `args` global (action: run)." }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description: 'Default true (false without a UI). false waits for the result inside this call (action: run).',
        }),
      ),
      runId: Type.Optional(
        Type.String({ description: 'Workflow id (wf-…) or agent run id (action: status | stop | pause | resume).' }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: 'Optional wall-clock cap for the run. Default none.' })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = params.action;

      if (action === 'list') {
        const items = listWorkflows(ctx.cwd, ctx.isProjectTrusted());
        if (items.length === 0)
          return text('No saved workflows. Drop .js files in ~/.pi/agent/workflows/ or .pi/workflows/.');
        const lines = items.map((w) => `  ${w.name} [${w.scope}]${w.description ? ` — ${w.description}` : ''}`);
        return text(`Saved workflows (${items.length}):\n${lines.join('\n')}`, { count: items.length });
      }
      if (action === 'status') return text(status(params.runId));
      if (action === 'pause' || action === 'resume') return text(pauseOrResume(action, params.runId));
      if (action === 'stop') return text(params.runId ? stop(params.runId) : 'stop requires runId.');

      // action === 'run'
      const req = resolveRunRequest(params, ctx.cwd, ctx.isProjectTrusted(), runs);
      if ('error' in req) return text(req.error);
      // Print mode exits when the turn ends, which would kill a background run.
      const background = params.background ?? ctx.hasUI;
      // Background runs deliberately ignore the tool signal: pi may abort it
      // after execute returns, which would kill the run.
      const run = launch(ctx, req, {
        timeoutMs: params.timeoutMs,
        ...(background ? { onSettled: (r: WorkflowRun) => deliver(r, true) } : { signal: signal ?? undefined }),
      });
      if (background) {
        const replay = req.relaunch ? ' Completed agents from the earlier run replay from its journal.' : '';
        return text(
          `Started workflow ${run.id} (${run.meta?.name ?? run.label}) in the background.${replay} Its result arrives as a message when it finishes. Watch it with /workflows; stop it with workflow stop runId=${run.id}.`,
          { id: run.id, label: run.label, background: true },
        );
      }
      await run.done;
      return text(`Workflow ${formatRunResult(run)}`, { id: run.id, label: run.label, status: run.status });
    },
  });

  // ── /wf — thin human-facing wrapper ───────────────────────────────────
  pi.registerCommand('wf', {
    description:
      'Workflows: /wf list | /wf run <name> [argsJson] | /wf relaunch <id> | /wf save <id> [name] | /wf status [id] | /wf stop <id> | /wf pause [id] | /wf resume [id]. Saved workflows live in ~/.pi/agent/workflows/*.js (global) and .pi/workflows/*.js (project, trusted only).',
    getArgumentCompletions: (argumentPrefix) => {
      if (argumentPrefix.includes(' ')) return null;
      const prefix = argumentPrefix.trim();
      const subs = ['list', 'run', 'relaunch', 'save', 'status', 'stop', 'pause', 'resume'].filter((s) =>
        s.startsWith(prefix),
      );
      if (subs.length === 0) return null;
      return subs.map((s) => ({ value: s + ' ', label: s }));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];
      const usage =
        'Usage: /wf list | /wf run <name> [argsJson] | /wf relaunch <id> | /wf save <id> [name] | /wf status [id] | /wf stop <id> | /wf pause [id] | /wf resume [id]';
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
      if (sub === 'run' || sub === 'relaunch') {
        const target = parts[1];
        if (!target) {
          ctx.ui.notify(usage, 'warning');
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
        const req = resolveRunRequest(
          sub === 'run' ? { name: target, args: parsedArgs } : { relaunch: target, args: parsedArgs },
          ctx.cwd,
          ctx.isProjectTrusted(),
          runs,
        );
        if ('error' in req) {
          ctx.ui.notify(req.error, 'error');
          return;
        }
        const run = launch(ctx, req, { onSettled: (r) => deliver(r, false) });
        ctx.ui.notify(`Started workflow ${run.id} (${run.label}). Watch it with /workflows.`, 'info');
        return;
      }
      if (sub === 'save') {
        if (!parts[1]) ctx.ui.notify('Usage: /wf save <id> [name]', 'warning');
        else await saveRun(ctx, parts[1], parts[2]);
        return;
      }
      if (sub === 'pause' || sub === 'resume') {
        ctx.ui.notify(pauseOrResume(sub, parts[1]), 'info');
        return;
      }
      if (sub === 'status') {
        ctx.ui.notify(status(parts[1]), 'info');
        return;
      }
      if (sub === 'stop') {
        ctx.ui.notify(parts[1] ? stop(parts[1]) : usage, parts[1] ? 'info' : 'warning');
        return;
      }
      ctx.ui.notify(usage, 'warning');
    },
  });
}

// ── Run lookup / cancellation resolution ──────────────────────────────────

/** Find a run by full id or unique 8-char prefix across live + persisted records. */
function findRun(runtime: SubagentRuntime, runId: string): RunArtifact | undefined {
  const live = runtime.listRuns() as RunArtifact[];
  const persisted = readRunArtifacts(artifactsRoot());
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
