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
import * as fs from 'node:fs';
import * as os from 'node:os';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { getAgentDir, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import {
  getKeybindings,
  Key,
  matchesKey,
  SelectList,
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
  parseAmpDispatch,
  parseUnifiedDiff,
  type PatchHunk,
  type ParsedPatch,
  type RunArtifact,
  type SpawnOptions,
  type SpawnResult,
  type SubagentRuntime,
  type SpawnUsage,
} from '@nicknisi/pi-shared';
import { Type } from 'typebox';

const ARTIFACTS_ROOT = path.join(getAgentDir(), 'subagent-runs');
const PATCHES_STATE_DIR = path.join(getAgentDir(), 'subagent-patches');
const PATCHES_STATE_FILE = path.join(PATCHES_STATE_DIR, 'state.json');
const STATUS_KEY = 'subagents';
const INLINE_WIDGET_KEY = 'subagents-inline';
/** Toggle the fleet radar overlay. Rebind via ~/.pi/agent/keybindings.json. */
const RADAR_SHORTCUT = 'alt+ctrl+f';
const STATUS_INTERVAL = 2000;
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

function toSpawnOptions(spec: TaskSpec, cwd: string, parentSession: string | undefined): SpawnOptions {
  const opts: SpawnOptions = {
    prompt: spec.task,
    tools: spec.tools ?? DEFAULT_TOOLS,
    cwd,
  };
  if (spec.agent) opts.agent = spec.agent;
  if (spec.model) opts.model = spec.model;
  if (spec.systemPrompt) opts.systemPrompt = spec.systemPrompt;
  if (spec.worktree) opts.worktree = true;
  if (parentSession) opts.parentSession = parentSession;
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

/** Most recent transcript entry (turn N or tool name) — the run's "current tool" / last activity. */
function lastActivity(run: RunArtifact): { kind: 'turn' | 'tool'; label: string } | undefined {
  const t = run.transcript;
  if (!t || t.length === 0) return undefined;
  return t[t.length - 1];
}

/**
 * Per-run radar lane: status icon + identity in the label, and a one-line
 * digest (model · current tool · token burn · last activity) in the
 * description — the tmux-choose-tree row analogue.
 */
function runLane(run: RunArtifact, theme: Theme): { label: string; description: string } {
  const model = run.model ? ` ${theme.fg('dim', run.model)}` : '';
  const activity = lastActivity(run);
  const tool = activity?.kind === 'tool' ? `${theme.fg('muted', '⚙')} ${activity.label}` : '';
  const tokens = run.usage ? `${(run.usage.totalTokens / 1000).toFixed(1)}k tok` : '';
  const bits = [tool, tokens, relativeTime(run.startedAt)].filter(Boolean).join(theme.fg('dim', ' · '));
  const prompt = short(sanitizeTerminalLabel(run.promptPreview ?? ''), 56);
  return {
    label: `${runIcon(run, theme)} ${sanitizeTerminalLabel(runTitle(run))}${model}`,
    description: `${bits ? `${bits}${theme.fg('dim', ' · ')}${prompt}` : prompt}`,
  };
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
  private readonly tick: ReturnType<typeof setInterval>;

  constructor(
    private readonly runs: RunArtifact[],
    initial: RunArtifact | undefined,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly refresh: () => RunArtifact[],
    private readonly close: () => void,
    private readonly cancelRun: (runId: string) => void,
  ) {
    const items: SelectItem[] = runs.map((run) => ({ value: run.runId, ...runLane(run, theme) }));
    this.list = new SearchableSelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
    this.list.onSelect = (item) => {
      const run = this.runs.find((r) => r.runId === item.value);
      if (run) this.openDetail(run);
    };
    this.list.onCancel = () => this.dismiss();
    // Live runs mutate underneath the overlay — re-collect once a second so
    // an open detail view tracks current activity instead of a frozen snapshot.
    this.tick = setInterval(() => {
      const fresh = this.refresh();
      this.runs.length = 0;
      this.runs.push(...fresh);
      if (this.mode === 'detail' && this.detail) {
        this.detail = fresh.find((r) => r.runId === this.detail!.runId) ?? this.detail;
      }
      this.invalidate();
      this.tui.requestRender();
    }, 1000);
    if (initial) this.openDetail(initial);
  }

  private dismiss(): void {
    clearInterval(this.tick);
    this.close();
  }

  private openDetail(run: RunArtifact): void {
    this.detail = run;
    this.mode = 'detail';
    this.scrollTop = 0;
    this.invalidate();
    this.tui.requestRender();
  }

  /** Cancel the run under the cursor (list) or the open one (detail). */
  private cancelCurrent(): void {
    let run: RunArtifact | null = null;
    if (this.mode === 'detail') run = this.detail;
    else {
      const item = this.list.selectList.getSelectedItem();
      if (item) run = this.runs.find((r) => r.runId === item.value) ?? null;
    }
    if (!run) return;
    this.cancelRun(run.runId);
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
      } else if (matchesKey(data, 'c')) {
        this.cancelCurrent();
      } else {
        return;
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // 'c' cancels only when the filter is empty — otherwise the keystroke
    // belongs to the SearchableSelectList's type-to-filter input.
    if (matchesKey(data, 'c') && this.list.filterValue === '') {
      this.cancelCurrent();
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
    const turns = run.transcript?.filter((e) => e.kind === 'turn').length ?? 0;
    const tools = run.transcript?.filter((e) => e.kind === 'tool').length ?? 0;
    if (turns + tools > 0) meta.push(`${turns} turn${turns === 1 ? '' : 's'} · ${tools} tool${tools === 1 ? '' : 's'}`);
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
    } else if (run.status === 'running' || run.status === 'queued') {
      lines.push(theme.fg('dim', '(running — final answer not ready yet)'));
    } else {
      lines.push(theme.fg('dim', '(no output recorded)'));
    }
    if (run.transcript && run.transcript.length > 0) {
      lines.push(theme.fg('borderMuted', '─'.repeat(Math.max(1, contentWidth))));
      lines.push(theme.fg('muted', run.endedAt ? 'activity' : 'activity (live)'));
      for (const entry of run.transcript.slice(-10)) {
        const text = entry.kind === 'turn' ? theme.fg('accent', entry.label) : theme.fg('dim', `→ ${entry.label}`);
        lines.push(truncateToWidth(text, contentWidth, '…'));
      }
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
      const working = this.runs.filter((r) => r.status === 'running' || r.status === 'queued').length;
      const done = this.runs.filter((r) => r.status === 'completed').length;
      const failed = this.runs.filter((r) => r.status === 'failed' || r.status === 'aborted').length;
      const counts =
        working + done + failed > 0
          ? this.theme.fg(
              'dim',
              `  ${this.theme.fg('accent', String(working))} working · ${this.theme.fg('success', String(done))} done · ${this.theme.fg('error', String(failed))} failed`,
            )
          : '';
      pushBoxLine(
        ` ${this.theme.fg('accent', this.theme.bold('Fleet'))}${this.theme.fg('dim', ` — ${this.runs.length} run${this.runs.length === 1 ? '' : 's'}`)}${counts}`,
      );
      for (const line of this.list.render(contentWidth)) pushBoxLine(` ${line}`);
      pushBoxLine();
      pushBoxLine(this.theme.fg('dim', ' type to filter • Enter inspect • c cancel • Esc close'));
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
      pushBoxLine(this.theme.fg('dim', `${scrollInfo} ↑↓ scroll • PgUp/PgDn page • c cancel • Esc back`));
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

// ── /patches staging area ─────────────────────────────────────────────────
//
// Worktree subagents hand back .patch files beside their run artifacts. This
// is the central integration surface: a keyboard-driven overlay over every
// pending patch with diffstat, a clean/conflicts/stale pre-flight (checked
// WITHOUT applying, via `git apply --check`), apply / apply-selected-hunk /
// discard, and an expandable full-diff view. Apply/discard decisions persist
// to ~/.pi/agent/subagent-patches/state.json so /patches survives restart.

interface PatchState {
  version: 1;
  decisions: Record<string, { decision: 'applied' | 'discarded'; at: number }>;
}
interface PatchEntry {
  runId: string;
  patchPath: string;
  parsed: ParsedPatch;
  stamp: 'clean' | 'conflicts' | 'stale';
  decision: 'applied' | 'discarded' | undefined;
  promptPreview: string;
  agent?: string | undefined;
  changedFiles: number;
  startedAt: number;
}

const PATCH_DIFF_CAP = 2000;

function loadPatchState(): PatchState {
  try {
    const j = JSON.parse(fs.readFileSync(PATCHES_STATE_FILE, 'utf8')) as Partial<PatchState>;
    if (j && j.decisions) return { version: 1, decisions: j.decisions };
  } catch {
    // missing/corrupt state — start fresh
  }
  return { version: 1, decisions: {} };
}

function savePatchState(state: PatchState): void {
  try {
    fs.mkdirSync(PATCHES_STATE_DIR, { recursive: true });
    const tmp = `${PATCHES_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, PATCHES_STATE_FILE);
  } catch {
    // best-effort persistence; a lost decision just means the patch re-appears
  }
}

/** Pre-flight WITHOUT applying: `git apply --check`. Stale = a modified (non-created) target no longer exists in the working tree. */
async function stampPatch(
  pi: ExtensionAPI,
  cwd: string,
  parsed: ParsedPatch,
  patchPath: string,
): Promise<'clean' | 'conflicts' | 'stale'> {
  try {
    const check = await pi.exec('git', ['apply', '--check', patchPath], { cwd, timeout: 5000 });
    if (check.code === 0) return 'clean';
  } catch {
    // git unavailable / error — treat as conflicts so the user inspects manually
    return 'conflicts';
  }
  for (const f of parsed.files) {
    if (f.created) continue;
    if (!f.path) continue;
    // Deletions carry their source path, so an already-deleted target reads stale.
    if (!fs.existsSync(path.resolve(cwd, f.path))) return 'stale';
  }
  return 'conflicts';
}

async function collectPatches(pi: ExtensionAPI, runtime: SubagentRuntime, cwd: string): Promise<PatchEntry[]> {
  const state = loadPatchState();
  const artifacts = new Map<string, RunArtifact>();
  for (const a of readRunArtifacts(ARTIFACTS_ROOT)) artifacts.set(a.runId, a);
  const entries: PatchEntry[] = [];
  let namespaces: fs.Dirent[];
  try {
    namespaces = fs.readdirSync(ARTIFACTS_ROOT, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const ns of namespaces) {
    if (!ns.isDirectory()) continue;
    const dir = path.join(ARTIFACTS_ROOT, ns.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.patch')) continue;
      const runId = f.name.slice(0, -'.patch'.length);
      const patchPath = path.join(dir, f.name);
      let diff: string;
      try {
        diff = fs.readFileSync(patchPath, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseUnifiedDiff(diff);
      const run = artifacts.get(runId);
      const stamp = await stampPatch(pi, cwd, parsed, patchPath);
      entries.push({
        runId,
        patchPath,
        parsed,
        stamp,
        decision: state.decisions[patchPath]?.decision,
        promptPreview: run?.promptPreview ?? '',
        agent: run?.agent,
        changedFiles: run?.worktree?.changedFiles ?? parsed.files.length,
        startedAt: run?.startedAt ?? 0,
      });
    }
  }
  return entries.sort((a, b) => b.startedAt - a.startedAt);
}

async function applyWholePatch(
  pi: ExtensionAPI,
  cwd: string,
  patchPath: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await pi.exec('git', ['apply', '--3way', patchPath], { cwd, timeout: 30000 });
    if (res.code === 0) return { ok: true, message: '' };
    return { ok: false, message: (res.stderr || res.stdout || `git apply exited ${res.code}`).trim() };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function applySingleHunk(
  pi: ExtensionAPI,
  cwd: string,
  parsed: ParsedPatch,
  hunk: PatchHunk,
): Promise<{ ok: boolean; message: string }> {
  const file = parsed.files[hunk.fileIndex];
  if (!file) return { ok: false, message: 'hunk has no owning file' };
  const sub = [...file.header, hunk.header, ...hunk.body].join('\n') + '\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-patch-'));
  const tmp = path.join(dir, 'hunk.patch');
  try {
    fs.writeFileSync(tmp, sub);
    const res = await pi.exec('git', ['apply', '--3way', tmp], { cwd, timeout: 30000 });
    if (res.code === 0) return { ok: true, message: '' };
    return { ok: false, message: (res.stderr || res.stdout || `git apply exited ${res.code}`).trim() };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

function stampIcon(stamp: PatchEntry['stamp'], theme: Theme): string {
  switch (stamp) {
    case 'clean':
      return theme.fg('success', '✓');
    case 'conflicts':
      return theme.fg('warning', '!');
    case 'stale':
      return theme.fg('dim', '⊘');
  }
}

function diffstatLine(parsed: ParsedPatch, theme: Theme): string {
  const plus = theme.fg('success', `+${parsed.totalAdded}`);
  const minus = theme.fg('error', `-${parsed.totalRemoved}`);
  const files = `${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'}`;
  return `${plus} ${minus} ${theme.fg('dim', files)}`;
}

class PatchesOverlay implements Component, Focusable {
  focused = false;

  private mode: 'list' | 'diff' = 'list';
  private list: SelectList;
  private diff: PatchEntry | null = null;
  private diffLines: string[] = [];
  private hunkStarts: number[] = [];
  private focusedHunk = 0;
  private scrollTop = 0;
  private viewport = 10;
  private contentTotal = 0;
  private status: string | null = null;
  private busy = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private patches: PatchEntry[],
    private state: PatchState,
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly pi: ExtensionAPI,
    private readonly cwd: string,
    private readonly notify: (message: string, type?: 'info' | 'warning' | 'error') => void,
    private readonly close: () => void,
  ) {
    const items: SelectItem[] = patches.map((p) => ({
      value: p.patchPath,
      label: `${stampIcon(p.stamp, theme)} ${p.runId.slice(0, 8)}${p.agent ? ` ${theme.fg('dim', p.agent)}` : ''} ${diffstatLine(p.parsed, theme)}`,
      description: `${p.stamp} · ${p.changedFiles} changed · ${relativeTime(p.startedAt)} · ${short(sanitizeTerminalLabel(p.promptPreview), 48)}`,
    }));
    this.list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
    this.list.onSelect = (item) => {
      const entry = this.patches.find((p) => p.patchPath === item.value);
      if (entry) this.openDiff(entry);
    };
    this.list.onCancel = () => this.close();
  }

  private selected(): PatchEntry | null {
    const item = this.list.getSelectedItem();
    if (!item) return null;
    return this.patches.find((p) => p.patchPath === item.value) ?? null;
  }

  private openDiff(entry: PatchEntry): void {
    this.diff = entry;
    this.mode = 'diff';
    this.buildDiffLines(entry);
    this.focusedHunk = 0;
    this.scrollTop = 0;
    this.invalidate();
    this.tui.requestRender();
  }

  private buildDiffLines(entry: PatchEntry): void {
    const theme = this.theme;
    const lines: string[] = [];
    this.hunkStarts = [];
    let lastFile = -1;
    for (const h of entry.parsed.hunks) {
      if (h.fileIndex !== lastFile) {
        const file = entry.parsed.files[h.fileIndex];
        if (file) for (const h2 of file.header) lines.push(theme.fg('dim', h2));
        lastFile = h.fileIndex;
      }
      this.hunkStarts.push(lines.length);
      lines.push(theme.fg('accent', h.header));
      for (const raw of h.body) {
        if (raw.startsWith('+') && !raw.startsWith('+++')) lines.push(theme.fg('toolDiffAdded', raw));
        else if (raw.startsWith('-') && !raw.startsWith('---')) lines.push(theme.fg('toolDiffRemoved', raw));
        else if (raw.startsWith('\\')) lines.push(theme.fg('dim', raw));
        else lines.push(raw);
      }
    }
    if (lines.length > PATCH_DIFF_CAP) {
      this.diffLines = lines.slice(0, PATCH_DIFF_CAP);
      this.diffLines.push(theme.fg('dim', `… ${lines.length - PATCH_DIFF_CAP} more lines (truncated)`));
    } else {
      this.diffLines = lines;
    }
  }

  private setDecision(entry: PatchEntry, decision: 'applied' | 'discarded'): void {
    this.state.decisions[entry.patchPath] = { decision, at: Date.now() };
    savePatchState(this.state);
    this.patches = this.patches.filter((p) => p.patchPath !== entry.patchPath);
    if (this.diff?.patchPath === entry.patchPath) this.diff = null;
  }

  private async applyWhole(entry: PatchEntry): Promise<void> {
    this.busy = true;
    this.status = `applying ${entry.runId.slice(0, 8)}…`;
    this.tui.requestRender();
    const res = await applyWholePatch(this.pi, this.cwd, entry.patchPath);
    this.busy = false;
    if (res.ok) {
      this.setDecision(entry, 'applied');
      this.status = `applied ${entry.runId.slice(0, 8)}`;
      this.notify(`Applied patch ${entry.runId.slice(0, 8)}`, 'info');
      this.mode = 'list';
    } else {
      this.status = `apply failed: ${short(res.message, 80)}`;
      this.notify(`Apply failed: ${res.message}`, 'error');
    }
    this.rebuildList();
    this.invalidate();
    this.tui.requestRender();
  }

  private async applyHunk(entry: PatchEntry): Promise<void> {
    const hunk = entry.parsed.hunks[this.focusedHunk];
    if (!hunk) {
      this.notify('No hunk focused (use n/p to move).', 'warning');
      return;
    }
    this.busy = true;
    this.status = `applying hunk ${this.focusedHunk + 1}…`;
    this.tui.requestRender();
    const res = await applySingleHunk(this.pi, this.cwd, entry.parsed, hunk);
    this.busy = false;
    if (res.ok) {
      this.status = `applied hunk ${this.focusedHunk + 1} of ${entry.parsed.hunks.length}`;
      this.notify(`Applied hunk ${this.focusedHunk + 1} (other hunks remain pending).`, 'info');
    } else {
      this.status = `hunk failed: ${short(res.message, 80)}`;
      this.notify(`Hunk apply failed: ${res.message}`, 'error');
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private rebuildList(): void {
    const items: SelectItem[] = this.patches.map((p) => ({
      value: p.patchPath,
      label: `${stampIcon(p.stamp, this.theme)} ${p.runId.slice(0, 8)}${p.agent ? ` ${this.theme.fg('dim', p.agent)}` : ''} ${diffstatLine(p.parsed, this.theme)}`,
      description: `${p.stamp} · ${p.changedFiles} changed · ${relativeTime(p.startedAt)} · ${short(sanitizeTerminalLabel(p.promptPreview), 48)}`,
    }));
    this.list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
    this.list.onSelect = (item) => {
      const entry = this.patches.find((p) => p.patchPath === item.value);
      if (entry) this.openDiff(entry);
    };
    this.list.onCancel = () => this.close();
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (this.mode === 'diff' && this.diff) {
      const entry = this.diff;
      if (matchesKey(data, Key.escape) || matchesKey(data, 'e')) {
        this.mode = 'list';
        this.diff = null;
      } else if (matchesKey(data, Key.up)) {
        this.scrollTop = Math.max(0, this.scrollTop - 1);
      } else if (matchesKey(data, Key.down)) {
        this.scrollTop = Math.min(Math.max(0, this.contentTotal - this.viewport), this.scrollTop + 1);
      } else if (matchesKey(data, Key.pageUp)) {
        this.scrollTop = Math.max(0, this.scrollTop - this.viewport);
      } else if (matchesKey(data, Key.pageDown)) {
        this.scrollTop = Math.min(Math.max(0, this.contentTotal - this.viewport), this.scrollTop + this.viewport);
      } else if (matchesKey(data, 'n')) {
        this.focusedHunk = Math.min(entry.parsed.hunks.length - 1, this.focusedHunk + 1);
        this.scrollToHunk();
      } else if (matchesKey(data, 'p')) {
        this.focusedHunk = Math.max(0, this.focusedHunk - 1);
        this.scrollToHunk();
      } else if (matchesKey(data, 's')) {
        void this.applyHunk(entry);
      } else if (matchesKey(data, Key.enter)) {
        void this.applyWhole(entry);
      } else {
        return;
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'e')) {
      const entry = this.selected();
      if (entry) this.openDiff(entry);
      return;
    }
    if (matchesKey(data, 'd')) {
      const entry = this.selected();
      if (entry) {
        this.setDecision(entry, 'discarded');
        this.notify(`Discarded patch ${entry.runId.slice(0, 8)}`, 'info');
        this.rebuildList();
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = this.selected();
      if (entry) void this.applyWhole(entry);
      return;
    }
    this.list.handleInput(data);
    this.list.invalidate();
    this.invalidate();
    this.tui.requestRender();
  }

  private scrollToHunk(): void {
    const start = this.hunkStarts[this.focusedHunk] ?? 0;
    this.scrollTop = Math.min(start, Math.max(0, this.contentTotal - this.viewport));
  }

  private border(text: string): string {
    return this.theme.fg('border', text);
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
    const applied = Object.values(this.state.decisions).filter((d) => d.decision === 'applied').length;
    const discarded = Object.values(this.state.decisions).filter((d) => d.decision === 'discarded').length;
    const title = ` ${this.theme.fg('accent', this.theme.bold('Patches'))}${this.theme.fg('dim', ` — ${this.patches.length} pending`)}${this.theme.fg('dim', ` · ${applied} applied · ${discarded} discarded`)}`;
    pushBoxLine(title);

    if (this.mode === 'list') {
      if (this.patches.length === 0) {
        pushBoxLine(` ${this.theme.fg('dim', 'No pending patches.')}`);
      } else {
        for (const line of this.list.render(contentWidth)) pushBoxLine(` ${line}`);
      }
      pushBoxLine();
      if (this.status) pushBoxLine(` ${this.theme.fg('muted', this.status)}`);
      pushBoxLine(this.theme.fg('dim', ' ↑↓ select • Enter apply • e expand • d discard • Esc close'));
    } else if (this.diff) {
      const all = this.diffLines;
      const maxViewport = Math.max(4, Math.floor(this.tui.terminal.rows * 0.7) - 6);
      const viewport = Math.min(maxViewport, all.length);
      this.contentTotal = all.length;
      this.viewport = viewport;
      this.scrollTop = Math.min(this.scrollTop, Math.max(0, all.length - viewport));
      const slice = all.slice(this.scrollTop, this.scrollTop + viewport);
      for (let i = 0; i < slice.length; i++) {
        const abs = this.scrollTop + i;
        const hunkIdx = this.hunkStarts.indexOf(abs);
        const marker = hunkIdx === this.focusedHunk ? this.theme.fg('accent', '▶ ') : '  ';
        pushBoxLine(` ${marker}${slice[i]}`);
      }
      for (let i = slice.length; i < viewport; i++) pushBoxLine();
      const scrollInfo =
        all.length > viewport
          ? ` ${this.scrollTop + 1}–${Math.min(all.length, this.scrollTop + viewport)}/${all.length} •`
          : '';
      pushBoxLine(
        this.theme.fg(
          'dim',
          `${scrollInfo} hunk ${this.focusedHunk + 1}/${this.diff.parsed.hunks.length} • n/p hunk • s apply hunk • Enter apply all • e/Esc back`,
        ),
      );
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

// ── Fleet radar: shared overlay opener + ambient statusline ─────────────

/**
 * Open the fleet radar overlay (the /fleet and the keyboard shortcut share
 * this path). The overlay lists every run as a per-child lane — status,
 * model, current tool, token burn, last activity — with `c` cancelling the
 * focused run via the cascading-cancellation registry and Enter drilling
 * into the live transcript.
 */
function openFleetOverlay(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext,
  runtime: SubagentRuntime,
  initial: RunArtifact | undefined,
): Promise<void> {
  const all = collectFleet(runtime.listRuns() as RunArtifact[]);
  const cancelRun = (runId: string) => {
    const controller = cancellables.get(runId);
    if (!controller) {
      const fresh = collectFleet(runtime.listRuns() as RunArtifact[]);
      const run = fresh.find((r) => r.runId === runId);
      ctx.ui.notify(
        run && (run.status === 'running' || run.status === 'queued')
          ? `Run ${runId.slice(0, 8)} isn't cancellable from here (it belongs to a different host process).`
          : `Run ${runId.slice(0, 8)} already finished.`,
        'warning',
      );
      return;
    }
    controller.abort();
    ctx.ui.notify(`Cancelled run ${runId.slice(0, 8)}`, 'info');
  };
  void pi;
  return ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      widgetTheme = theme;
      return new FleetOverlay(
        all,
        initial,
        tui,
        theme,
        () => collectFleet(runtime.listRuns() as RunArtifact[]),
        () => done(undefined),
        cancelRun,
      );
    },
    { overlay: true, overlayOptions: { width: '80%', maxHeight: '70%', anchor: 'center' } },
  );
}

/** Recompute working/done/failed counts and reflect them in the footer statusline. */
function refreshStatusline(ui: ExtensionUIContext, theme: Theme | null, runtime: SubagentRuntime): void {
  let all: RunArtifact[];
  try {
    all = collectFleet(runtime.listRuns() as RunArtifact[]);
  } catch {
    return;
  }
  const working = all.filter((r) => r.status === 'running' || r.status === 'queued').length;
  const done = all.filter((r) => r.status === 'completed').length;
  const failed = all.filter((r) => r.status === 'failed' || r.status === 'aborted').length;
  if (working === 0) {
    ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const text = theme
    ? `${theme.fg('accent', '●')} ${theme.fg('dim', 'fleet ')}${theme.fg('accent', String(working))}${theme.fg('dim', ' working · ')}${theme.fg('success', String(done))}${theme.fg('dim', ' done · ')}${theme.fg('error', String(failed))}${theme.fg('dim', ' failed')}`
    : `fleet ${working} working · ${done} done · ${failed} failed`;
  ui.setStatus(STATUS_KEY, text);
}

let statusTimer: ReturnType<typeof setInterval> | undefined;
let statusUi: ExtensionUIContext | null = null;
let statusTheme: Theme | null = null;

// ── & dispatch prefix: inline single-subagent runs ────────────────────────
//
// `&scout how does auth work` at position zero intercepts the input, dispatches
// ONE child inline (reusing the same spawnCancellable path as the dispatch
// tool), surfaces live progress as a widget above the editor, and lands the
// final result as a collapsible `subagents:inline` custom message that uses
// the same render vocabulary as a dispatch tool result. Each dispatch is also
// captured as a `subagents:dispatch` custom entry so `/again` can re-fire it.

function inlineComponent(getLines: (width: number) => string[]): Component {
  return {
    render: (width: number) => getLines(width).map((l) => truncateToWidth(l, width)),
    invalidate: () => {},
  };
}

function renderInlineWidget(ctx: ExtensionContext, details: DispatchDetails, frame: number): void {
  if (!ctx.hasUI) return;
  const theme = (ctx.ui as ExtensionUIContext).theme;
  const task = details.tasks[0];
  if (!task) return;
  const spinner = theme
    ? theme.fg('muted', SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)
    : SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
  const header = theme ? dispatchHeader(task.label, theme, `${spinner} `) : `${spinner} ${task.label}`;
  const lines = [header, ''];
  if (theme) lines.push(...renderTaskTree(details.tasks, theme, frame));
  try {
    ctx.ui.setWidget(INLINE_WIDGET_KEY, lines, { placement: 'aboveEditor' });
  } catch {
    // best-effort; a lost widget update during shutdown is harmless
  }
}

async function dispatchInline(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: SubagentRuntime,
  spec: TaskSpec,
): Promise<void> {
  const parentSession = ctx.sessionManager?.getSessionFile();
  const task: TaskProgress = { label: spec.agent ?? short(spec.task, 40), status: 'pending' };
  if (spec.model) task.model = spec.model;
  const details: DispatchDetails = { tasks: [task], settled: false };

  let frame = 0;
  const widgetTimer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    renderInlineWidget(ctx, details, frame);
  }, SPINNER_INTERVAL);
  task.status = 'working';
  task.startedAt = Date.now();
  renderInlineWidget(ctx, details, 0);

  const done = spawnCancellable(runtime, toSpawnOptions(spec, ctx.cwd, parentSession), undefined);
  const runId = (done as Promise<SpawnResult> & { runId: string }).runId;
  task.runId = runId;

  let result: SpawnResult;
  try {
    result = await done;
  } catch (err) {
    result = {
      ok: false,
      runId,
      kind: 'crashed',
      error: err instanceof Error ? err.message : String(err),
      text: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
    };
  }
  clearInterval(widgetTimer);
  try {
    ctx.ui.setWidget(INLINE_WIDGET_KEY, undefined);
  } catch {
    // best-effort
  }

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
  details.settled = true;

  const content = result.ok
    ? `## ${task.label} — ${formatSeconds(task.startedAt, task.doneAt)}${formatTokens(result.usage)}\n\n${result.text.slice(0, MAX_TASK_OUTPUT_CHARS)}`
    : `## ✗ ${task.label} — ${result.kind} (${formatSeconds(task.startedAt, task.doneAt)})\n\n${result.error}${result.text ? `\n\nPartial output:\n${result.text.slice(0, 1000)}` : ''}`;
  try {
    pi.sendMessage({ customType: 'subagents:inline', content, display: true, details });
  } catch {
    // sending into a dying session is best-effort
  }
  try {
    pi.appendEntry('subagents:dispatch', {
      prompt: spec.task,
      agentType: spec.agent,
      worktree: !!spec.worktree,
      runId,
      at: Date.now(),
    });
  } catch {
    // best-effort persistence
  }
}

export default function subagents(pi: ExtensionAPI) {
  const runtime = createSubagentRuntime({ namespace: 'subagents', artifactsDir: ARTIFACTS_ROOT });
  // GC old artifacts (7d retention, incl. worktrees + patches) and reap
  // ghost 'running' records left by dead host processes. Once per process.
  sweepRunArtifactsOnce(ARTIFACTS_ROOT);

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    statusUi = ctx.ui;
    statusTheme = (ctx.ui as ExtensionUIContext).theme ?? null;
    refreshStatusline(statusUi, statusTheme, runtime);
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      if (statusUi) refreshStatusline(statusUi, statusTheme ?? widgetTheme, runtime);
    }, STATUS_INTERVAL);
  });

  // Deterministic cascading cancellation: Esc/quit/reload/session-replacement
  // must not orphan in-process children. Foreground tasks are already aborted
  // via the tool signal pi passes to execute(), but background runs deliberately
  // carry no tool signal (pi aborts tool signals after execute returns, which
  // would kill them prematurely) — they only die here. Aborting a controller
  // triggers session.abort() in runChild, which tears down the child and, for
  // worktree runs, removes the worktree immediately (no patch captured). A
  // hard exit (SIGKILL) that skips this handler is caught on the next host
  // startup by sweepRunArtifactsOnce, which reaps ghost runs AND their
  // worktrees.
  pi.on('session_shutdown', () => {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
    statusUi?.setStatus(STATUS_KEY, undefined);
    statusUi = null;
    for (const controller of cancellables.values()) {
      try {
        controller.abort();
      } catch {
        // best-effort; one failing abort must not skip the rest
      }
    }
  });

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

      // Owning pi session file path, for parentSession linkage on the
      // dual-written standard session JSONL mirror. undefined in print /
      // in-memory hosts — the mirror is still written, just unparented.
      const parentSession = ctx.sessionManager?.getSessionFile();

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
        const done = spawnCancellable(runtime, toSpawnOptions(spec, ctx.cwd, parentSession), undefined);
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
            const result = await spawnCancellable(
              runtime,
              toSpawnOptions(spec, ctx.cwd, parentSession),
              signal ?? undefined,
            );
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
        const result = await spawnCancellable(
          runtime,
          toSpawnOptions(spec, ctx.cwd, parentSession),
          signal ?? undefined,
        );
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
      // Header only — the tree is rendered solely by renderResult. pi keeps
      // the renderCall component on screen alongside renderResult once the
      // first onUpdate fires, and emit() populates liveDispatches and fires
      // onUpdate together — so rendering the tree here too shows it twice.
      return makeText(ctx.lastComponent, dispatchHeader(summary, theme, spinner));
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
        run.sessionFile ? `session: ${run.sessionFile} (pi /resume, /tree, --fork)` : undefined,
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

      await openFleetOverlay(pi, ctx, runtime, initial);
    },
  });

  // Fleet radar overlay — one keyboard shortcut (rebind via keybindings.json).
  pi.registerShortcut(RADAR_SHORTCUT, {
    description: 'Open the subagent fleet radar overlay',
    handler: async (ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('The fleet radar overlay needs the TUI.', 'warning');
        return;
      }
      const all = collectFleet(runtime.listRuns() as RunArtifact[]);
      if (all.length === 0) {
        ctx.ui.notify('No subagent runs found.', 'info');
        return;
      }
      await openFleetOverlay(pi, ctx, runtime, undefined);
    },
  });

  pi.registerCommand('patches', {
    description: 'Staging area for worktree-subagent patches: pre-flight, apply, apply a hunk, or discard',
    handler: async (_args, ctx) => {
      const all = await collectPatches(pi, runtime, ctx.cwd);
      const pending = all.filter((p) => !p.decision);
      if (!ctx.hasUI) {
        postText(
          pi,
          ctx,
          pending.length === 0
            ? 'No pending patches.'
            : pending
                .map(
                  (p) =>
                    `- ${p.runId.slice(0, 8)} [${p.stamp}] +${p.parsed.totalAdded} -${p.parsed.totalRemoved} · ${short(p.promptPreview, 60)}`,
                )
                .join('\n'),
        );
        return;
      }
      if (pending.length === 0) {
        ctx.ui.notify('No pending patches.', 'info');
        return;
      }
      const state = loadPatchState();
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          widgetTheme = theme;
          return new PatchesOverlay(
            pending,
            state,
            theme,
            tui,
            pi,
            ctx.cwd,
            (m, t) => ctx.ui.notify(m, t),
            () => done(undefined),
          );
        },
        { overlay: true, overlayOptions: { width: '80%', maxHeight: '75%', anchor: 'center' } },
      );
    },
  });

  // `&<agent> <prompt>` at position zero dispatches a single subagent inline.
  // The run reuses the same spawn/cancel path as the dispatch tool; live progress
  // shows in an editor widget and the final result lands as a collapsible
  // `subagents:inline` message that uses the dispatch render vocabulary.
  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return { action: 'continue' };
    if (!event.text.startsWith('&')) return { action: 'continue' };
    if (!ctx.hasUI) return { action: 'continue' };
    const parsed = parseAmpDispatch(event.text);
    if (!parsed) {
      ctx.ui.notify('Usage: &<agent> <prompt> (e.g. &scout how does auth work)', 'warning');
      return { action: 'handled' };
    }
    const spec: TaskSpec = { task: parsed.prompt, agent: parsed.agentType };
    void dispatchInline(pi, ctx, runtime, spec);
    return { action: 'handled' };
  });

  // Collapsible transcript block for inline `&` dispatches — reuses the same
  // renderTaskTree / createExpandedDispatchView machinery as the dispatch tool.
  pi.registerMessageRenderer('subagents:inline', (message, { expanded }, theme) => {
    const details = message.details as DispatchDetails | undefined;
    if (!details?.tasks || details.tasks.length === 0) return undefined;
    const task = details.tasks[0]!;
    const dot = task.status === 'error' ? `${theme.fg('error', '✗')} ` : undefined;
    const model = task.model ? ` ${theme.fg('dim', task.model)}` : '';
    const header = dispatchHeader(`${task.label}${model}`, theme, dot);
    if (!expanded) {
      const tree = renderTaskTree(details.tasks, theme, 0);
      tree[tree.length - 1] += expandHint(theme);
      return inlineComponent(() => ['', header, ...tree]);
    }
    const view = createExpandedDispatchView(details.tasks, theme);
    return {
      render: (width: number) => ['', header, ...view.render(width)].map((l) => truncateToWidth(l, width)),
      invalidate: () => view.invalidate(),
    };
  });

  // `/again [amendment]` re-fires the last `&` dispatch verbatim, or with the
  // amendment appended. The last dispatch is recovered from the session's
  // `subagents:dispatch` custom entries, which survive restart.
  pi.registerCommand('again', {
    description: 'Re-fire the last & dispatch, optionally with an amendment appended',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('/again needs the TUI.', 'warning');
        return;
      }
      const entries = ctx.sessionManager.getEntries();
      let last: { data?: { prompt?: string; agentType?: string; worktree?: boolean } } | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!;
        if (e.type === 'custom' && (e as { customType?: string }).customType === 'subagents:dispatch') {
          last = e as typeof last;
          break;
        }
      }
      if (!last?.data?.prompt) {
        ctx.ui.notify('No prior & dispatch to re-fire.', 'warning');
        return;
      }
      const amendment = args.trim();
      const prompt = amendment ? `${last.data.prompt}\n\n${amendment}` : last.data.prompt;
      const spec: TaskSpec = {
        task: prompt,
        agent: last.data.agentType,
        worktree: last.data.worktree ? true : undefined,
      };
      void dispatchInline(pi, ctx, runtime, spec);
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
