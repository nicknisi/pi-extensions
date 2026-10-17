/**
 * /workflows — live progress view: runs → phases → agents → agent detail.
 * Keys mirror Claude Code's /workflows view where pi allows.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from '@earendil-works/pi-tui';
import { sanitizeTerminalLabel } from '@nicknisi/pi-shared';
import type { AgentState } from './engine.js';
import { agentCounts, formatRunLine, runUsage, type WorkflowRun } from './runs.js';

const NO_PHASE = '(no phase)';
const FILTERS = ['all', 'running', 'done', 'failed'] as const;
type Filter = (typeof FILTERS)[number];
type Level = 'runs' | 'phases' | 'agents' | 'detail';

/** What the caller should do after the view closes. */
export type ViewResult = { save: string } | undefined;

export function phaseGroups(run: WorkflowRun): string[] {
  const groups = [...run.phases];
  for (const a of run.agents) {
    const p = a.phase ?? NO_PHASE;
    if (!groups.includes(p)) groups.push(p);
  }
  return groups;
}

function matchesFilter(a: AgentState, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return a.status === 'running' || a.status === 'waiting';
  if (filter === 'done') return a.status === 'done' || a.status === 'cached';
  return a.status === 'failed';
}

function clean(text: string): string {
  return sanitizeTerminalLabel(text.replace(/\s+/g, ' ').trim());
}

export class WorkflowsView implements Component, Focusable {
  focused = false;
  private level: Level;
  private runId: string | undefined;
  private phase: string | undefined;
  private agentSeq: number | undefined;
  private cursor = 0;
  private filter: Filter = 'all';
  private scroll = 0;
  private readonly tick: ReturnType<typeof setInterval>;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly runs: () => WorkflowRun[],
    initialRunId: string | undefined,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (result: ViewResult) => void,
    private readonly onChange: () => void,
  ) {
    const all = runs();
    const only = all.length === 1 ? all[0]!.id : undefined;
    this.runId = initialRunId ?? only;
    this.level = this.runId ? 'phases' : 'runs';
    // Runs mutate underneath the view; redraw twice a second while open.
    this.tick = setInterval(() => this.refresh(), 500);
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private close(result?: ViewResult): void {
    clearInterval(this.tick);
    this.done(result);
  }

  private run(): WorkflowRun | undefined {
    return this.runs().find((r) => r.id === this.runId);
  }

  private agentsInPhase(run: WorkflowRun): AgentState[] {
    return run.agents.filter((a) => (a.phase ?? NO_PHASE) === this.phase && matchesFilter(a, this.filter));
  }

  private agent(run: WorkflowRun): AgentState | undefined {
    return run.agents.find((a) => a.seq === this.agentSeq);
  }

  /** Rows the cursor moves over at the current level. */
  private rowCount(): number {
    const run = this.run();
    if (this.level === 'runs') return this.runs().length;
    if (!run) return 0;
    if (this.level === 'phases') return phaseGroups(run).length;
    if (this.level === 'agents') return this.agentsInPhase(run).length;
    return 0;
  }

  private drill(): void {
    const run = this.run();
    if (this.level === 'runs') {
      const target = this.runs()[this.cursor];
      if (!target) return;
      this.runId = target.id;
      this.level = 'phases';
    } else if (this.level === 'phases' && run) {
      const phase = phaseGroups(run)[this.cursor];
      if (!phase) return;
      this.phase = phase;
      this.level = 'agents';
    } else if (this.level === 'agents' && run) {
      const agent = this.agentsInPhase(run)[this.cursor];
      if (!agent) return;
      this.agentSeq = agent.seq;
      this.level = 'detail';
      this.scroll = 0;
      return;
    } else {
      return;
    }
    this.cursor = 0;
  }

  private back(): void {
    if (this.level === 'detail') {
      this.level = 'agents';
      return;
    }
    if (this.level === 'agents') {
      this.level = 'phases';
      this.cursor = Math.max(0, phaseGroups(this.run()!).indexOf(this.phase ?? ''));
      return;
    }
    if (this.level === 'phases' && this.runs().length > 1) {
      this.level = 'runs';
      this.cursor = Math.max(
        0,
        this.runs().findIndex((r) => r.id === this.runId),
      );
      return;
    }
    this.close();
  }

  /** The agent under the cursor (agents level) or open in detail. */
  private targetAgent(): AgentState | undefined {
    const run = this.run();
    if (!run) return undefined;
    if (this.level === 'detail') return this.agent(run);
    if (this.level === 'agents') return this.agentsInPhase(run)[this.cursor];
    return undefined;
  }

  /** The run under the cursor (runs level) or the open one. */
  private targetRun(): WorkflowRun | undefined {
    return this.level === 'runs' ? this.runs()[this.cursor] : this.run();
  }

  handleInput(data: string): void {
    const rows = this.rowCount();
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) this.back();
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) this.drill();
    else if (this.level === 'detail' && (matchesKey(data, Key.up) || matchesKey(data, 'k'))) {
      this.scroll = Math.max(0, this.scroll - 1);
    } else if (this.level === 'detail' && (matchesKey(data, Key.down) || matchesKey(data, 'j'))) this.scroll++;
    else if (matchesKey(data, Key.up)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down)) this.cursor = Math.min(Math.max(0, rows - 1), this.cursor + 1);
    else if (matchesKey(data, 'f') && this.level === 'agents') {
      this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length]!;
      this.cursor = 0;
    } else if (matchesKey(data, 'p')) {
      const run = this.targetRun();
      if (run?.status === 'running') {
        if (run.gate.paused) run.gate.resume();
        else run.gate.pause();
        this.onChange();
      }
    } else if (matchesKey(data, 'x')) {
      const agent = this.targetAgent();
      if (agent) agent.stop();
      else if (this.level !== 'detail') {
        const run = this.targetRun();
        if (run?.status === 'running') run.controller.abort();
      }
    } else if (matchesKey(data, 'r')) {
      this.targetAgent()?.restart();
    } else if (matchesKey(data, 's')) {
      const run = this.targetRun();
      if (run) return this.close({ save: run.id });
    } else {
      return;
    }
    this.refresh();
  }

  private icon(status: AgentState['status'] | WorkflowRun['status']): string {
    const t = this.theme;
    switch (status) {
      case 'done':
      case 'completed':
        return t.fg('success', '✓');
      case 'cached':
        return t.fg('muted', '↺');
      case 'failed':
        return t.fg('error', '✗');
      case 'stopped':
        return t.fg('warning', '■');
      case 'running':
        return t.fg('accent', '●');
      default:
        return t.fg('dim', '◦');
    }
  }

  private runRow(run: WorkflowRun): string {
    return `${this.icon(run.status)} ${clean(formatRunLine(run))}`;
  }

  private phaseRow(run: WorkflowRun, phase: string): string {
    const agents = run.agents.filter((a) => (a.phase ?? NO_PHASE) === phase);
    const done = agents.filter((a) => a.status === 'done' || a.status === 'cached').length;
    const failed = agents.filter((a) => a.status === 'failed').length;
    const running = agents.length - done - failed;
    const status = running > 0 ? 'running' : failed > 0 ? 'failed' : agents.length > 0 ? 'done' : 'waiting';
    const counts = `${done}/${agents.length} done${running ? ` · ${running} running` : ''}${failed ? ` · ${failed} failed` : ''}`;
    return `${this.icon(status)} ${clean(phase)} ${this.theme.fg('dim', counts)}`;
  }

  private agentRow(a: AgentState): string {
    const bits = [
      a.status,
      a.usage.totalTokens ? `${(a.usage.totalTokens / 1000).toFixed(1)}k tok` : '',
      a.attempts > 1 ? `attempt ${a.attempts}` : '',
    ].filter(Boolean);
    const name = a.label ? `${clean(a.label)} ` : '';
    return `${this.icon(a.status)} ${name}${this.theme.fg('dim', `${bits.join(' · ')} · ${clean(a.prompt)}`)}`;
  }

  private detailLines(run: WorkflowRun, a: AgentState, width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const wrap = (text: string) => {
      for (const raw of text.split('\n')) {
        const line = sanitizeTerminalLabel(raw);
        lines.push(...(line ? wrapTextWithAnsi(line, width) : ['']));
      }
    };
    const secs = Math.round(((a.endedAt ?? Date.now()) - a.startedAt) / 1000);
    lines.push(`${this.icon(a.status)} ${t.bold(clean(a.label ?? `agent ${a.seq + 1}`))}`);
    lines.push(
      t.fg(
        'muted',
        [
          a.status,
          `${secs}s`,
          `${a.usage.totalTokens} tok`,
          `attempt ${Math.max(1, a.attempts)}`,
          a.phase ?? NO_PHASE,
        ].join(' · '),
      ),
    );
    lines.push(t.fg('borderMuted', '─'.repeat(width)), t.fg('muted', 'prompt'));
    wrap(a.prompt);
    if (a.error) {
      lines.push(t.fg('borderMuted', '─'.repeat(width)));
      lines.push(...wrapTextWithAnsi(t.fg('error', sanitizeTerminalLabel(a.error)), width));
    }
    lines.push(t.fg('borderMuted', '─'.repeat(width)), t.fg('muted', 'result'));
    if (a.result) wrap(a.result);
    else lines.push(t.fg('dim', a.status === 'running' || a.status === 'waiting' ? '(running…)' : '(no result)'));
    void run;
    return lines;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    const boxWidth = Math.min(Math.max(width, 20), 140);
    const inner = Math.max(1, boxWidth - 2);
    const content = Math.max(1, inner - 2);
    const maxRows = Math.max(4, Math.floor(this.tui.terminal.rows * 0.7) - 6);
    const out: string[] = [t.fg('border', `╭${'─'.repeat(inner)}╮`)];
    const push = (line = '') => {
      const clipped = truncateToWidth(line, inner, '…');
      out.push(
        `${t.fg('border', '│')}${clipped}${' '.repeat(Math.max(0, inner - visibleWidth(clipped)))}${t.fg('border', '│')}`,
      );
    };
    const list = (rows: string[]) => {
      this.cursor = Math.min(this.cursor, Math.max(0, rows.length - 1));
      const start = Math.max(0, Math.min(this.cursor - Math.floor(maxRows / 2), rows.length - maxRows));
      if (rows.length === 0) push(t.fg('dim', '  (nothing here yet)'));
      rows.slice(start, start + maxRows).forEach((row, i) => {
        const selected = start + i === this.cursor;
        push(selected ? t.bg('selectedBg', `${t.fg('accent', '›')} ${row}`) : `  ${row}`);
      });
    };

    const run = this.run();
    if (this.level === 'runs' || !run) {
      const all = this.runs();
      push(
        ` ${t.fg('accent', t.bold('Workflows'))}${t.fg('dim', ` — ${all.length} run${all.length === 1 ? '' : 's'}`)}`,
      );
      list(all.map((r) => this.runRow(r)));
      push();
      push(t.fg('dim', ' ↑↓ select • Enter open • p pause • x stop • s save • Esc close'));
    } else {
      const c = agentCounts(run);
      const paused = run.status === 'running' && run.gate.paused ? ' [paused]' : '';
      push(
        ` ${this.icon(run.status)} ${t.bold(clean(run.meta?.name ?? run.label))}${t.fg('dim', ` ${run.id} — ${run.status}${paused} · ${c.done}/${c.total} done · ${runUsage(run).totalTokens} tok`)}`,
      );
      if (this.level === 'phases') {
        list(phaseGroups(run).map((p) => this.phaseRow(run, p)));
        push();
        push(t.fg('dim', ' ↑↓ select • Enter agents • p pause • x stop run • s save • Esc back'));
      } else if (this.level === 'agents') {
        push(t.fg('muted', ` ${clean(this.phase ?? '')}${this.filter === 'all' ? '' : ` · showing ${this.filter}`}`));
        list(this.agentsInPhase(run).map((a) => this.agentRow(a)));
        push();
        push(t.fg('dim', ' ↑↓ select • Enter detail • f filter • x stop • r restart • p pause • Esc back'));
      } else {
        const agent = this.agent(run);
        const lines = agent ? this.detailLines(run, agent, content) : [t.fg('dim', '(agent not found)')];
        this.scroll = Math.min(this.scroll, Math.max(0, lines.length - maxRows));
        const slice = lines.slice(this.scroll, this.scroll + maxRows);
        for (const line of slice) push(` ${line}`);
        const range =
          lines.length > maxRows ? ` ${this.scroll + 1}–${this.scroll + slice.length}/${lines.length} •` : '';
        push();
        push(t.fg('dim', `${range} j/k scroll • x stop • r restart • Esc back`));
      }
    }
    out.push(t.fg('border', `╰${'─'.repeat(inner)}╯`));
    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
