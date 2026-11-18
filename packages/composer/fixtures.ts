/**
 * Test fixtures: a runtime that looks like a real session in each visual
 * state, without a TUI. Shared by the render tests.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import type { ComposerConfig, StateName } from './config.js';
import { geometry, renderAbove, renderEditor, renderFooter, type Ctx } from './render.js';
import { createRuntime, type Runtime } from './state.js';

/** Plain theme: no escapes, so widths are easy to read in failures. */
export const plainTheme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
} as unknown as Theme;

/** ANSI theme: wraps every colour so width maths has to skip escapes. */
export const ansiTheme = {
  fg: (_c: string, t: string) => `\x1b[38;2;120;130;140m${t}\x1b[39m`,
  bg: (_c: string, t: string) => `\x1b[48;2;30;30;40m${t}\x1b[49m`,
} as unknown as Theme;

export interface Scenario {
  state: StateName;
  text?: string;
  pastes?: number;
  contextPercentUsed?: number;
  contextColor?: Runtime['contextColor'];
}

export const SCENARIOS: Record<StateName, Scenario> = {
  idle: { state: 'idle' },
  typing: { state: 'typing', text: 'refactor the footer so the context bar never disappears at forty columns' },
  paste: {
    state: 'paste',
    text: 'here is the failing output:\n[paste #1 +42 lines]\nwhy does the bar vanish?',
    pastes: 1,
  },
  scrolled: { state: 'scrolled' },
  nearFull: { state: 'nearFull', contextPercentUsed: 92, contextColor: 'error' },
  working: { state: 'working' },
  tool: { state: 'tool' },
  prompt: { state: 'prompt' },
};

const VERB = '⠋ Morse coding gravity...';

export function runtimeFor(s: Scenario): Runtime {
  const rt = createRuntime();
  rt.now = () => 1_000_000;
  const text = s.text ?? '';
  rt.editor = { getText: () => text, pasteCount: () => s.pastes ?? 0 };
  rt.sessionName = 'Pi Footer Composer Design Mockups';
  rt.contextColor = s.contextColor;
  rt.ctx = {
    cwd: '/Users/me/Developer/pi-extensions',
    model: { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'faux', reasoning: true },
    getContextUsage: () => ({ tokens: 58_000, percent: s.contextPercentUsed ?? 29, contextWindow: 200_000 }),
    sessionManager: { getBranch: () => [] },
    ui: { theme: plainTheme },
  } as unknown as ExtensionContext;
  rt.pi = { getThinkingLevel: () => 'high' } as unknown as ExtensionAPI;
  rt.footerData = {
    getGitBranch: () => 'feat/artifact-reply-any-comment',
    getExtensionStatuses: () =>
      new Map([
        ['answer-hint', '? ctrl+. to answer'],
        ['pi-goal', '◎ goal: ship footer lab'],
      ]),
  };
  rt.tui = { mode: 'fullscreen', isFollowingOutput: s.state !== 'scrolled' } as unknown as TUI;
  if (s.state === 'working' || s.state === 'tool' || s.state === 'prompt') {
    rt.busy = true;
    rt.busySince = 1_000_000 - 12_000;
    rt.tokens = 1284;
    rt.tps = [10, 40, 80, 84, 70];
    rt.indicator = {
      renderInBorder: (w: number) => (VERB.length <= w ? VERB : `${VERB.slice(0, Math.max(0, w - 1))}…`),
      renderSpinnerInBorder: () => '⠋',
    };
  }
  if (s.state === 'tool' || s.state === 'prompt') rt.tool = { name: 'bash', detail: '', since: 0 };
  if (s.state === 'prompt') rt.prompt = { title: 'Allow command?' };
  return rt;
}

/** What pi's stock editor renders at a content width: rules around the text rows. */
export function stockLines(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const raw of text.split('\n')) {
    let rest = raw;
    do {
      rows.push(rest.slice(0, width).padEnd(width));
      rest = rest.slice(width);
    } while (rest.length > 0);
  }
  return ['─'.repeat(width), ...rows, '─'.repeat(width)];
}

export interface Frame {
  above: string[];
  editor: string[];
  footer: string[];
}

export function renderAll(cfg: ComposerConfig, s: Scenario, width: number, theme: Theme = plainTheme): Frame {
  const rt = runtimeFor(s);
  const c: Ctx = { cfg, rt, theme };
  const g = geometry(cfg, width);
  // A dialog replaces the editor in the prompt state; everywhere else composer must draw it.
  let editor: string[] = [];
  if (s.state !== 'prompt') {
    const rendered = renderEditor(c, width, stockLines(s.text ?? '', g.contentWidth));
    if (!rendered) throw new Error(`renderEditor fell back to pi's stock editor for ${s.state} @ ${width}`);
    editor = rendered;
  }
  return { above: renderAbove(c, width), editor, footer: renderFooter(c, width) };
}
