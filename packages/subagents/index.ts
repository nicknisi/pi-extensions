/**
 * First-party subagent dispatch + fleet for pi.
 *
 * `dispatch` — model-facing fan-out: run N focused child agents in parallel
 *   with per-task tool allowlists, models, and prompts; typed results
 *   aggregate back. Children are hermetic in-process sessions spawned through
 *   @nicknisi/pi-shared's runtime — no pi-subagents dependency, and children
 *   cannot themselves spawn. Live progress streams via renderCall/renderResult
 *   (✓/✗ rows, └─ sub-lines, spinner), matching llm-council's vocabulary.
 * `fleet` (tool) / `/fleet` (command) — inspect live and persisted runs,
 *   including background ones. Run records persist to
 *   <agentDir>/subagent-runs/<namespace>/<runId>.json, so runs from other
 *   extensions using the shared runtime show up here too. In TUI mode `/fleet`
 *   opens an interactive overlay (searchable list → run detail); otherwise it
 *   falls back to a plain-text transcript entry.
 * Background dispatches surface in a one-line widget above the editor while
 *   any are in flight.
 */

import * as path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import { getAgentDir, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import {
  getKeybindings,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  createSubagentRuntime,
  readRunArtifacts,
  sweepRunArtifactsOnce,
  sanitizeTerminalLabel,
  SearchableSelectList,
  type RunArtifact,
  type SpawnOptions,
  type SpawnResult,
  type SubagentRuntime,
  type SpawnUsage,
} from '@nicknisi/pi-shared';
import { Type } from 'typebox';

const ARTIFACTS_ROOT = path.join(getAgentDir(), 'subagent-runs');
const MAX_TASKS = 8;
const DEFAULT_TOOLS = ['read', 'grep', 'find', 'ls'];
const TREE_MUTATING_TOOLS = new Set(['edit', 'write', 'bash']);
const MAX_TASK_OUTPUT_CHARS = 4000;
const MAX_FLEET_LIST = 20;

// ── Render vocabulary (mirrors llm-council's defaults) ───────────────────

const SPINNER_CHARS = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()];
const SPINNER_INTERVAL = 80;
const BRANCH_PREFIX = '└─';
const TREE_INDENT = '   '; // visibleWidth('└─') + 1
const EXPANDED_PREVIEW_LINES = 8;
const BG_WIDGET_KEY = 'subagents-bg';

interface TaskSpec {
  task: string;
  agent?: string | undefined;
  model?: string | undefined;
  tools?: string[] | undefined;
  systemPrompt?: string | undefined;
  background?: boolean | undefined;
  allowTreeMutation?: boolean | undefined;
  worktree?: boolean | undefined;
}

type TaskStatus = 'pending' | 'working' | 'done' | 'error' | 'background';

type TaskProgress = {
  label: string;
  model?: string | undefined;
  status: TaskStatus;
  startedAt?: number | undefined;
  doneAt?: number | undefined;
  error?: string | undefined;
  text?: string | undefined;
  tokens?: SpawnUsage | undefined;
  runId?: string | undefined;
};

type DispatchDetails = {
  tasks: TaskProgress[];
  settled: boolean;
};

function wantsTreeMutation(spec: TaskSpec): boolean {
  // Worktree-isolated tasks never touch the caller's tree, so they need
  // neither the allowTreeMutation declaration nor serialization.
  if (spec.worktree) return false;
  return (spec.tools ?? []).some((tool) => TREE_MUTATING_TOOLS.has(tool));
}

function toSpawnOptions(spec: TaskSpec, cwd: string): SpawnOptions {
  const opts: SpawnOptions = {
    prompt: spec.task,
    tools: spec.tools ?? DEFAULT_TOOLS,
    cwd,
  };
  if (spec.agent) opts.agent = spec.agent;
  if (spec.model) opts.model = spec.model;
  if (spec.systemPrompt) opts.systemPrompt = spec.systemPrompt;
  if (spec.worktree) opts.worktree = true;
  return opts;
}

function short(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatTokens(usage: { totalTokens: number } | undefined): string {
  if (!usage) return '';
  const k = usage.totalTokens / 1000;
  return `, ${k >= 10 ? Math.round(k) : k.toFixed(1)}k tok`;
}

function formatSeconds(startedAt: number, endedAt?: number): string {
  const end = endedAt ?? Date.now();
  return `${((end - startedAt) / 1000).toFixed(1)}s`;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatRunLine(run: RunArtifact): string {
  const bits = [run.status, formatSeconds(run.startedAt, run.endedAt) + (run.endedAt ? '' : '…')];
  const tokens = formatTokens(run.usage);
  return `- ${run.runId.slice(0, 8)} [${run.namespace}]${run.agent ? ` ${run.agent}` : ''} — ${bits.join(', ')}${tokens} · ${short(run.promptPreview ?? '', 60)}`;
}

function collectFleet(live: RunArtifact[]): RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const record of readRunArtifacts(ARTIFACTS_ROOT)) byId.set(record.runId, record);
  // Live wins for status/timing, but live records carry no output — keep the artifact's.
  for (const record of live) {
    const persisted = byId.get(record.runId);
    byId.set(record.runId, { ...persisted, ...record, output: record.output ?? persisted?.output });
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

function postText(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string) {
  pi.sendMessage({
    customType: 'subagents:fleet',
    content: text,
    display: true,
    details: { kind: 'subagents-fleet' },
  });
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

// ── Dispatch tree rendering ──────────────────────────────────────────────

function makeText(lastComponent: unknown, text: string): Text {
  const comp = lastComponent instanceof Text ? lastComponent : new Text('', 0, 0);
  comp.setText(text);
  return comp;
}

function indentLine(text: string): string {
  return `${TREE_INDENT}${text}`;
}

function branchLine(text: string, theme: Theme): string {
  return `${theme.fg('dim', BRANCH_PREFIX)} ${text}`;
}

function expandHint(theme: Theme): string {
  const key = getKeybindings().getKeys('app.tools.expand')[0] ?? 'ctrl+o';
  return theme.fg('dim', ` • ${key} to expand`);
}

function dispatchHeader(summary: string, theme: Theme, dot?: string): string {
  const prefix = dot ?? `${theme.fg('success', '✓')} `;
  return `${prefix}${theme.fg('toolTitle', theme.bold('Dispatch'))} ${theme.fg('dim', summary)}`;
}

function taskIcon(status: TaskStatus, theme: Theme, frame: number): string {
  switch (status) {
    case 'done':
      return theme.fg('success', '✓');
    case 'error':
      return theme.fg('error', '✗');
    case 'working':
      return theme.fg('muted', SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!);
    case 'background':
      return theme.fg('accent', '◦');
    default:
      return theme.fg('muted', '↪');
  }
}

function taskSubLine(task: TaskProgress, theme: Theme): string {
  const elapsed = task.startedAt ? theme.fg('dim', ` (${formatSeconds(task.startedAt, task.doneAt)})`) : '';
  switch (task.status) {
    case 'done':
      return `${theme.fg('success', 'done')}${elapsed}${theme.fg('dim', formatTokens(task.tokens))}`;
    case 'error':
      return `${theme.fg('error', short(task.error ?? 'failed', 60))}${elapsed}`;
    case 'working':
      return theme.fg('dim', 'working…');
    case 'background':
      return theme.fg('dim', `launched · run ${task.runId?.slice(0, 8) ?? '?'}`);
    default:
      return theme.fg('dim', 'waiting');
  }
}

function renderTaskTree(tasks: TaskProgress[], theme: Theme, frame: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const model = task.model ? ` ${theme.fg('dim', task.model)}` : '';
    lines.push(indentLine(`${taskIcon(task.status, theme, frame)} ${theme.fg('accent', task.label)}${model}`));
    lines.push(indentLine(branchLine(taskSubLine(task, theme), theme)));
    if (i < tasks.length - 1) lines.push('');
  }
  return lines;
}

/** Expanded view: settled rows plus a short output preview per task. */
function createExpandedDispatchView(tasks: TaskProgress[], theme: Theme) {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    render(width: number): string[] {
      if (cachedLines && cachedWidth === width) return cachedLines;
      const contentWidth = Math.max(1, width - TREE_INDENT.length * 2);
      const lines: string[] = [''];
      for (const task of tasks) {
        const model = task.model ? ` ${theme.fg('dim', task.model)}` : '';
        lines.push(indentLine(`${taskIcon(task.status, theme, 0)} ${theme.fg('accent', task.label)}${model}`));
        lines.push(indentLine(branchLine(taskSubLine(task, theme), theme)));
        if (task.status === 'error' && task.error) {
          lines.push(indentLine(indentLine(theme.fg('error', short(task.error, 200)))));
        }
        const body = task.text?.trim();
        if (body) {
          const bodyLines = body.split('\n');
          for (const raw of bodyLines.slice(0, EXPANDED_PREVIEW_LINES)) {
            lines.push(indentLine(indentLine(truncateToWidth(sanitizeTerminalLabel(raw), contentWidth, '…'))));
          }
          if (bodyLines.length > EXPANDED_PREVIEW_LINES) {
            lines.push(
              indentLine(indentLine(theme.fg('dim', `… ${bodyLines.length - EXPANDED_PREVIEW_LINES} more lines`))),
            );
          }
        }
        lines.push('');
      }
      cachedWidth = width;
      cachedLines = lines;
      return lines;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}

// ── Live progress bridge (renderCall workaround for isPartial bug) ───────
// Keyed by toolCallId so two concurrent dispatch calls never cross-wire.

const liveDispatches = new Map<string, DispatchDetails>();

// ── Background-runs widget ───────────────────────────────────────────────

const backgroundRuns = new Map<string, string>(); // runId → label
let widgetUi: ExtensionUIContext | null = null;
let widgetTheme: Theme | null = null; // renderers/overlay capture the live theme

function refreshBackgroundWidget(): void {
  if (!widgetUi) return;
  try {
    if (backgroundRuns.size === 0) {
      widgetUi.setWidget(BG_WIDGET_KEY, undefined);
      return;
    }
    const count = backgroundRuns.size;
    const names = [...backgroundRuns.values()].map((name) => short(name, 24)).join(', ');
    const line = widgetTheme
      ? `${widgetTheme.fg('dim', '◦ ')}${widgetTheme.fg('accent', String(count))}${widgetTheme.fg('dim', ` background run${count === 1 ? '' : 's'}: ${names}`)}`
      : `◦ ${count} background run${count === 1 ? '' : 's'}: ${names}`;
    widgetUi.setWidget(BG_WIDGET_KEY, [line], { placement: 'aboveEditor' });
  } catch {
    // The completion callback can fire while the session is ending; a lost
    // widget update is harmless and must not become an unhandled rejection.
  }
}

// ── /fleet overlay ───────────────────────────────────────────────────────

function runTitle(run: RunArtifact): string {
  return `[${run.namespace}]${run.agent ? ` ${run.agent}` : ''}`;
}

function runIcon(run: RunArtifact, theme: Theme): string {
  switch (run.status) {
    case 'completed':
      return theme.fg('success', '✓');
    case 'failed':
    case 'aborted':
      return theme.fg('error', '✗');
    case 'running':
      return theme.fg('accent', '●');
    default:
      return theme.fg('dim', '◦');
  }
}

class FleetOverlay implements Component, Focusable {
  focused = false;

  private mode: 'list' | 'detail' = 'list';
  private readonly list: SearchableSelectList;
  private detail: RunArtifact | null = null;
  private scrollTop = 0;
  private viewport = 10;
  private contentTotal = 0;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly runs: RunArtifact[],
    initial: RunArtifact | undefined,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly close: () => void,
  ) {
    const items: SelectItem[] = runs.map((run) => ({
      value: run.runId,
      label: `${runIcon(run, theme)} ${sanitizeTerminalLabel(runTitle(run))}`,
      description: `${relativeTime(run.startedAt)} · ${short(sanitizeTerminalLabel(run.promptPreview ?? ''), 60)}`,
    }));
    this.list = new SearchableSelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
    this.list.onSelect = (item) => {
      const run = this.runs.find((r) => r.runId === item.value);
      if (run) this.openDetail(run);
    };
    this.list.onCancel = () => this.close();
    if (initial) this.openDetail(initial);
  }

  private openDetail(run: RunArtifact): void {
    this.detail = run;
    this.mode = 'detail';
    this.scrollTop = 0;
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.mode === 'detail') {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        this.mode = 'list';
        this.detail = null;
      } else if (matchesKey(data, Key.up)) {
        this.scrollTop = Math.max(0, this.scrollTop - 1);
      } else if (matchesKey(data, Key.down)) {
        this.scrollTop = Math.min(Math.max(0, this.contentTotal - this.viewport), this.scrollTop + 1);
      } else if (matchesKey(data, Key.pageUp)) {
        this.scrollTop = Math.max(0, this.scrollTop - this.viewport);
      } else if (matchesKey(data, Key.pageDown)) {
        this.scrollTop = Math.min(Math.max(0, this.contentTotal - this.viewport), this.scrollTop + this.viewport);
      } else {
        return;
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    this.list.handleInput(data);
    this.list.invalidate();
    this.invalidate();
    this.tui.requestRender();
  }

  private border(text: string): string {
    return this.theme.fg('border', text);
  }

  /** Full (unclipped) content lines for the detail view. */
  private detailLines(run: RunArtifact, contentWidth: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    lines.push(`${runIcon(run, theme)} ${theme.bold(sanitizeTerminalLabel(runTitle(run)))}`);
    const meta = [
      run.status,
      formatSeconds(run.startedAt, run.endedAt) + (run.endedAt ? '' : '…'),
      relativeTime(run.startedAt),
    ];
    if (run.usage) meta.push(`${(run.usage.totalTokens / 1000).toFixed(1)}k tok`);
    lines.push(theme.fg('muted', meta.join(' · ')));
    if (run.model) lines.push(theme.fg('muted', `model: ${run.model}`));
    lines.push(theme.fg('dim', short(sanitizeTerminalLabel(run.promptPreview ?? ''), Math.max(20, contentWidth))));
    if (run.error) lines.push(theme.fg('error', `error: ${short(sanitizeTerminalLabel(run.error), 200)}`));
    lines.push(theme.fg('borderMuted', '─'.repeat(Math.max(1, contentWidth))));
    const output = run.output?.trim();
    if (output) {
      for (const raw of output.split('\n')) {
        const clean = sanitizeTerminalLabel(raw);
        if (!clean) {
          lines.push('');
          continue;
        }
        for (const wrapped of wrapTextWithAnsi(clean, contentWidth)) lines.push(wrapped);
      }
    } else {
      lines.push(
        theme.fg(
          'dim',
          run.status === 'running' || run.status === 'queued'
            ? '(still running — no output yet)'
            : '(no output recorded)',
        ),
      );
    }
    return lines;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const boxWidth = Math.min(Math.max(width, 20), 120);
    const innerWidth = Math.max(1, boxWidth - 2);
    const contentWidth = Math.max(1, innerWidth - 2);
    const lines: string[] = [];
    const pushBoxLine = (content = '') => {
      const line = truncateToWidth(content, innerWidth, '…');
      const padding = Math.max(0, innerWidth - visibleWidth(line));
      lines.push(this.border('│') + line + ' '.repeat(padding) + this.border('│'));
    };

    lines.push(this.border(`╭${'─'.repeat(innerWidth)}╮`));

    if (this.mode === 'list') {
      pushBoxLine(
        ` ${this.theme.fg('accent', this.theme.bold('Fleet'))}${this.theme.fg('dim', ` — ${this.runs.length} run${this.runs.length === 1 ? '' : 's'}`)}`,
      );
      for (const line of this.list.render(contentWidth)) pushBoxLine(` ${line}`);
      pushBoxLine();
      pushBoxLine(this.theme.fg('dim', ' type to filter • Enter details • Esc close'));
    } else if (this.detail) {
      pushBoxLine(
        ` ${this.theme.fg('accent', this.theme.bold('Run'))}${this.theme.fg('dim', ` ${this.detail.runId.slice(0, 8)}`)}`,
      );
      const all = this.detailLines(this.detail, contentWidth);
      const maxViewport = Math.max(4, Math.floor(this.tui.terminal.rows * 0.7) - 6);
      const viewport = Math.min(maxViewport, all.length);
      this.contentTotal = all.length;
      this.viewport = viewport;
      this.scrollTop = Math.min(this.scrollTop, Math.max(0, all.length - viewport));
      const slice = all.slice(this.scrollTop, this.scrollTop + viewport);
      for (const line of slice) pushBoxLine(` ${line}`);
      for (let i = slice.length; i < viewport; i++) pushBoxLine();
      const scrollInfo =
        all.length > viewport
          ? ` ${this.scrollTop + 1}–${Math.min(all.length, this.scrollTop + viewport)}/${all.length} •`
          : '';
      pushBoxLine(this.theme.fg('dim', `${scrollInfo} ↑↓ scroll • PgUp/PgDn page • Esc back`));
    }

    lines.push(this.border(`╰${'─'.repeat(innerWidth)}╯`));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Extension ────────────────────────────────────────────────────────────

/** Live runId → AbortController, so the fleet tool can cancel in-flight runs. */
const cancellables = new Map<string, AbortController>();

function spawnCancellable(
  runtime: SubagentRuntime,
  opts: SpawnOptions,
  toolSignal: AbortSignal | undefined,
): Promise<SpawnResult> {
  // Always spawn detached so we can register the controller under the runId
  // BEFORE the run starts; callers just await done.
  const controller = new AbortController();
  const onToolAbort = () => controller.abort();
  if (toolSignal) {
    if (toolSignal.aborted) controller.abort();
    else toolSignal.addEventListener('abort', onToolAbort, { once: true });
  }
  const { runId, done } = runtime.spawnDetached({ ...opts, signal: controller.signal });
  cancellables.set(runId, controller);
  void done.finally(() => {
    cancellables.delete(runId);
    toolSignal?.removeEventListener('abort', onToolAbort);
  });
  // Attach the runId so callers can report it without racing the registry.
  return Object.assign(done, { runId }) as Promise<SpawnResult>;
}

export default function subagents(pi: ExtensionAPI) {
  const runtime = createSubagentRuntime({ namespace: 'subagents', artifactsDir: ARTIFACTS_ROOT });
  // GC old artifacts (7d retention, incl. worktrees + patches) and reap
  // ghost 'running' records left by dead host processes. Once per process.
  sweepRunArtifactsOnce(ARTIFACTS_ROOT);

  pi.registerTool({
    name: 'dispatch',
    label: 'Dispatch Subagents',
    description: [
      'Fan out focused child agents in parallel: independent research questions, parallel reviews,',
      'second opinions, or scoped file investigations. Each child runs hermetically (no user',
      'extensions/skills/context files) with a read-only tool allowlist unless overridden, and',
      'returns its final answer. Children cannot spawn children. Not for trivial questions or',
      'sequential work — dispatch only when tasks are independent and parallel.',
      'Tasks whose tools include edit, write, or bash mutate the shared working tree: they require',
      'allowTreeMutation: true and run sequentially after the parallel batch. Prefer worktree: true',
      'for builders instead — isolated worktrees stay parallel and hand off a patch for central integration.',
    ].join(' '),
    promptSnippet: 'Fan out parallel child agents for independent subtasks',
    promptGuidelines: [
      `Use dispatch for independent parallel subtasks (max ${MAX_TASKS}); never for sequential work or trivial questions.`,
      'Children default to read-only tools (read, grep, find, ls). Pass tools explicitly for builders.',
      'Set background: true for long-running tasks; results surface via the fleet tool.',
      'Tasks with edit/write/bash tools need allowTreeMutation: true and serialize after the parallel batch — or set worktree: true to isolate them and keep them parallel.',
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          task: Type.String({ description: 'The full prompt for this child agent' }),
          agent: Type.Optional(Type.String({ description: 'Label, e.g. "reviewer"' })),
          model: Type.Optional(Type.String({ description: 'Model spec, e.g. "anthropic/claude-haiku-4-5"' })),
          tools: Type.Optional(
            Type.Array(Type.String(), { description: 'Tool allowlist; default read-only (read, grep, find, ls)' }),
          ),
          systemPrompt: Type.Optional(Type.String({ description: 'Appended to the child system prompt' })),
          background: Type.Optional(Type.Boolean({ description: 'Run detached; check results via the fleet tool' })),
          allowTreeMutation: Type.Optional(
            Type.Boolean({
              description:
                'Required when tools include edit/write/bash; such tasks run sequentially after the parallel batch',
            }),
          ),
          worktree: Type.Optional(
            Type.Boolean({
              description:
                'Run in an isolated git worktree; writes never touch your tree. The full change set (incl. new files) lands as a .patch next to the run artifact — integrate centrally. Mutating tools stay parallel and need no allowTreeMutation.',
            }),
          ),
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const specs = params.tasks as TaskSpec[];
      if (specs.length === 0) {
        return toolResult('dispatch requires at least one task.');
      }
      if (specs.length > MAX_TASKS) {
        return toolResult(`Too many tasks (${specs.length}); max is ${MAX_TASKS}. Split into multiple dispatch calls.`);
      }

      if (ctx.hasUI) widgetUi = ctx.ui;

      const progress = new Map<TaskSpec, TaskProgress>();
      const details: DispatchDetails = { tasks: [], settled: false };
      for (const spec of specs) {
        const task: TaskProgress = { label: spec.agent ?? short(spec.task, 40), status: 'pending' };
        if (spec.model) task.model = spec.model;
        progress.set(spec, task);
        details.tasks.push(task);
      }

      const emit = () => {
        liveDispatches.set(toolCallId, details);
        const settledCount = details.tasks.filter((t) => t.status !== 'pending' && t.status !== 'working').length;
        onUpdate?.({
          content: [{ type: 'text', text: `[Dispatch] ${settledCount}/${details.tasks.length} done` }],
          details,
        });
      };
      emit();

      const settle = (task: TaskProgress, result: SpawnResult) => {
        task.doneAt = Date.now();
        task.tokens = result.usage;
        if (result.ok) {
          task.status = 'done';
          task.text = result.text;
        } else {
          task.status = 'error';
          task.error = result.error;
          if (result.text) task.text = result.text;
        }
      };

      const lines: string[] = [];

      // Refuse undeclared tree-mutating tasks outright; declared ones serialize after the parallel batch.
      const runnable: TaskSpec[] = [];
      const mutating: TaskSpec[] = [];
      for (const spec of specs) {
        if (wantsTreeMutation(spec)) {
          if (spec.allowTreeMutation === true) {
            mutating.push(spec);
          } else {
            const task = progress.get(spec)!;
            task.status = 'error';
            task.error = 'refused: edit/write/bash require allowTreeMutation';
            task.doneAt = Date.now();
            lines.push(
              `## ✗ ${task.label} — refused\n\nTools include edit/write/bash, which mutate the shared working tree. Resubmit with allowTreeMutation: true (the task will run sequentially, after the parallel batch).`,
            );
          }
        } else {
          runnable.push(spec);
        }
      }
      emit();

      const background = runnable.filter((s) => s.background);
      const foreground = runnable.filter((s) => !s.background);

      for (const spec of background) {
        const task = progress.get(spec)!;
        // Deliberately no tool signal for background runs: pi may abort tool
        // signals after execute returns, which would kill the child.
        const done = spawnCancellable(runtime, toSpawnOptions(spec, ctx.cwd), undefined);
        const runId = (done as Promise<SpawnResult> & { runId: string }).runId;
        task.status = 'background';
        task.runId = runId;
        task.startedAt = Date.now();
        lines.push(`⏳ ${task.label} — background run ${runId.slice(0, 8)} (check the fleet tool)`);
        backgroundRuns.set(runId, task.label);
        refreshBackgroundWidget();
        emit();
        // Deliberately no AbortSignal here: pi may abort tool signals after execute returns, which
        // would kill the background child. Swallow late failures — sendMessage throws once the
        // session is ending, and an unhandled rejection is worse than a lost notification.
        void done
          .then((result) => {
            backgroundRuns.delete(runId);
            refreshBackgroundWidget();
            pi.sendMessage({
              customType: 'subagents:background',
              content: `Background subagent ${runId.slice(0, 8)} (${task.label}) ${result.ok ? 'completed' : `failed: ${result.error}`}`,
              display: true,
              details: { runId, ok: result.ok },
            });
          })
          .catch((err) => {
            backgroundRuns.delete(runId);
            refreshBackgroundWidget();
            console.error(`[subagents] background run ${runId.slice(0, 8)} completion notice failed:`, err);
          });
      }

      if (foreground.length > 0) {
        const results = await Promise.all(
          foreground.map(async (spec) => {
            const task = progress.get(spec)!;
            task.status = 'working';
            task.startedAt = Date.now();
            emit();
            const result = await spawnCancellable(runtime, toSpawnOptions(spec, ctx.cwd), signal ?? undefined);
            settle(task, result);
            emit();
            return result;
          }),
        );
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          const label = progress.get(foreground[i]!)!.label;
          if (result.ok) {
            lines.push(
              `## ✓ ${label} — ${formatSeconds(0, result.durationMs)}${formatTokens(result.usage)}\n\n${result.text.slice(0, MAX_TASK_OUTPUT_CHARS)}`,
            );
          } else {
            lines.push(
              `## ✗ ${label} — ${result.kind} (${formatSeconds(0, result.durationMs)})\n\n${result.error}${result.text ? `\n\nPartial output:\n${result.text.slice(0, 1000)}` : ''}`,
            );
          }
        }
      }

      // Tree-mutating tasks run strictly sequentially, after the parallel batch, so they never
      // stomp the working tree concurrently with each other or with read-only children.
      for (const spec of mutating) {
        const task = progress.get(spec)!;
        task.status = 'working';
        task.startedAt = Date.now();
        emit();
        const result = await spawnCancellable(runtime, toSpawnOptions(spec, ctx.cwd), signal ?? undefined);
        settle(task, result);
        emit();
        if (result.ok) {
          lines.push(
            `## ✓ ${task.label} — ${formatSeconds(0, result.durationMs)}${formatTokens(result.usage)}\n\n${result.text.slice(0, MAX_TASK_OUTPUT_CHARS)}`,
          );
        } else {
          lines.push(
            `## ✗ ${task.label} — ${result.kind} (${formatSeconds(0, result.durationMs)})\n\n${result.error}${result.text ? `\n\nPartial output:\n${result.text.slice(0, 1000)}` : ''}`,
          );
        }
      }

      details.settled = true;
      liveDispatches.delete(toolCallId);
      return toolResult(lines.join('\n\n'), details);
    },

    renderCall(args, theme, ctx) {
      widgetTheme = theme;
      const count = Array.isArray(args?.tasks) ? args.tasks.length : 0;

      if (!ctx?.isPartial) {
        clearSpinner(ctx);
        liveDispatches.delete(ctx?.toolCallId ?? '');
        return makeText(ctx?.lastComponent, dispatchHeader(`${count} task${count === 1 ? '' : 's'}`, theme));
      }

      const frame = ensureSpinner(ctx);
      const details = liveDispatches.get(ctx.toolCallId) ?? null;
      const settled = details
        ? details.tasks.filter((t) => t.status !== 'pending' && t.status !== 'working').length
        : 0;
      const summary = details
        ? `${settled}/${details.tasks.length} done`
        : count > 0
          ? `${count} task${count === 1 ? '' : 's'}`
          : '...';
      const spinner = `${theme.fg('muted', SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)} `;
      const lines = [dispatchHeader(summary, theme, spinner)];
      if (details && details.tasks.length > 0) {
        lines.push('');
        lines.push(...renderTaskTree(details.tasks, theme, frame));
      }
      return makeText(ctx.lastComponent, lines.join('\n'));
    },

    renderResult(result, options, theme, ctx) {
      widgetTheme = theme;
      const details = result.details as DispatchDetails | undefined;

      // No tracked tasks (validation failures) — plain text fallback.
      if (!details?.tasks || details.tasks.length === 0) {
        const text = result.content[0];
        return makeText(ctx?.lastComponent, text?.type === 'text' ? text.text : '(no output)');
      }

      const frame = ctx?.state?.spinnerFrame ?? 0;

      if (!options?.expanded) {
        const tree = renderTaskTree(details.tasks, theme, frame);
        tree[tree.length - 1] += expandHint(theme);
        return makeText(ctx?.lastComponent, ['', ...tree].join('\n'));
      }

      return createExpandedDispatchView(details.tasks, theme);
    },
  });

  pi.registerTool({
    name: 'fleet',
    label: 'Subagent Fleet',
    description:
      'Inspect subagent runs: list recent runs (live and persisted, across extensions using the shared runtime) or fetch a specific run result by runId. Use to check background dispatch results.',
    promptSnippet: 'List or inspect subagent runs',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('result'), Type.Literal('cancel')], {
        description: 'list runs, fetch one result, or cancel a running run',
      }),
      runId: Type.Optional(Type.String({ description: 'Run id (or unique prefix) for action=result/cancel' })),
    }),
    async execute(_toolCallId, params) {
      const live = runtime.listRuns() as RunArtifact[];
      const all = collectFleet(live);
      if (params.action === 'list') {
        if (all.length === 0) return toolResult('No subagent runs found.');
        const text = all.slice(0, MAX_FLEET_LIST).map(formatRunLine).join('\n');
        return toolResult(text, { runs: all.slice(0, MAX_FLEET_LIST) });
      }
      if (!params.runId) {
        return toolResult(`action=${params.action} requires a runId (or prefix).`);
      }
      const matches = all.filter((r) => r.runId.startsWith(params.runId!));
      if (matches.length === 0) return toolResult(`No run matches '${params.runId}'.`);
      if (matches.length > 1) {
        return toolResult(`Ambiguous runId prefix; matches: ${matches.map((m) => m.runId.slice(0, 8)).join(', ')}`);
      }
      const run = matches[0]!;

      if (params.action === 'cancel') {
        const controller = cancellables.get(run.runId);
        if (!controller) {
          return toolResult(
            run.status === 'running' || run.status === 'queued'
              ? `Run ${run.runId.slice(0, 8)} is not cancellable from here — it belongs to a different host process (it will be reaped if that process died) or was not launched with cancel support.`
              : `Run ${run.runId.slice(0, 8)} already finished (${run.status}).`,
          );
        }
        controller.abort();
        return toolResult(`Cancelled run ${run.runId.slice(0, 8)} (${short(run.promptPreview ?? '', 60)}).`);
      }

      const text = [
        formatRunLine(run),
        run.error ? `error: ${run.error}` : undefined,
        run.worktree
          ? `worktree: ${run.worktree.path}${run.worktree.patchPath ? ` · patch: ${run.worktree.patchPath} (${run.worktree.changedFiles ?? 0} files)` : ' · no changes'}`
          : undefined,
        run.transcript && run.transcript.length > 0
          ? `transcript (last ${run.transcript.length}): ${run.transcript.map((t) => (t.kind === 'tool' ? `⚙${t.label}` : t.label)).join(' → ')}`
          : undefined,
        run.output
          ? `\n${run.output}`
          : run.status === 'running' || run.status === 'queued'
            ? '\n(still running — no output yet)'
            : '\n(no output recorded)',
      ]
        .filter(Boolean)
        .join('\n');
      return toolResult(text, { run });
    },
  });

  pi.registerCommand('fleet', {
    description: 'Show recent subagent runs (live + persisted, across extensions using the shared runtime)',
    handler: async (args, ctx) => {
      const all = collectFleet(runtime.listRuns() as RunArtifact[]);

      if (!ctx.hasUI) {
        postText(
          pi,
          ctx,
          all.length === 0 ? 'No subagent runs found.' : all.slice(0, MAX_FLEET_LIST).map(formatRunLine).join('\n'),
        );
        return;
      }

      if (all.length === 0) {
        ctx.ui.notify('No subagent runs found.', 'info');
        return;
      }

      // `/fleet <runId-prefix>` jumps straight to that run's detail view.
      let initial: RunArtifact | undefined;
      const query = args.trim();
      if (query) {
        const matches = all.filter((r) => r.runId.startsWith(query));
        if (matches.length === 1) {
          initial = matches[0];
        } else if (matches.length > 1) {
          ctx.ui.notify(`Ambiguous run id '${query}' (${matches.length} matches); showing the list`, 'warning');
        } else {
          ctx.ui.notify(`No run matches '${query}'; showing the list`, 'warning');
        }
      }

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          widgetTheme = theme;
          return new FleetOverlay(all, initial, tui, theme, () => done(undefined));
        },
        { overlay: true, overlayOptions: { width: '80%', maxHeight: '70%', anchor: 'center' } },
      );
    },
  });
}

// ── Spinner state (per tool-row renderer state) ──────────────────────────

function ensureSpinner(ctx: any): number {
  if (ctx?.state?.spinnerInterval) return ctx.state.spinnerFrame ?? 0;
  if (!ctx?.state) ctx.state = {};
  ctx.state.spinnerFrame = 0;
  ctx.state.spinnerInterval = setInterval(() => {
    ctx.state.spinnerFrame = (ctx.state.spinnerFrame + 1) % SPINNER_FRAMES.length;
    ctx.invalidate?.();
  }, SPINNER_INTERVAL);
  return 0;
}

function clearSpinner(ctx: any) {
  if (ctx?.state?.spinnerInterval) {
    clearInterval(ctx.state.spinnerInterval);
    ctx.state.spinnerInterval = undefined;
  }
}
