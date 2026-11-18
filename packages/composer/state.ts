/**
 * One state model for the whole bottom of the screen. The editor, footer,
 * above-row and side panel all read from here instead of each tracking
 * "is pi working" on its own.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import type { ComposerConfig, StateName } from './config.js';

export type ContextColor = 'success' | 'accent' | 'warning' | 'error' | 'dim';

/** pi's embedded StatusIndicator (working, retry, compaction, branch summary). */
export interface IndicatorLike {
  renderInBorder(width: number): string;
  renderSpinnerInBorder(width: number): string;
}

export interface FooterDataLike {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
}

export interface EditorLike {
  getText(): string;
  pasteCount(): number;
}

export interface Runtime {
  pi?: ExtensionAPI | undefined;
  ctx?: ExtensionContext | undefined;
  tui?: TUI | undefined;
  theme?: Theme | undefined;
  footerData?: FooterDataLike | undefined;
  editor?: EditorLike | undefined;
  /** The keybindings pi injects into the editor factory (follows the user's config). */
  keybindings?: { getKeys(action: never): string[] } | undefined;
  /** Between agent_start and agent_settled, or during a /composer preview. */
  busy: boolean;
  busySince: number;
  tool?: { name: string; detail: string; since: number } | undefined;
  toolCalls: Set<string>;
  prompt?: { title: string } | undefined;
  indicator?: IndicatorLike | undefined;
  contextColor?: ContextColor | undefined;
  sessionName?: string | undefined;
  labelOverride?: string | undefined;
  /** Output tokens this run (estimated from streamed text when the provider hasn't reported usage yet). */
  tokens: number;
  tokensDone: number;
  /** Tokens per one-second bucket, newest last. */
  tps: number[];
  tpsAt: number;
  toast?: { text: string; until: number } | undefined;
  paneFocused: boolean;
  /** /composer preview pins the visual state. */
  preview?: StateName | undefined;
  now: () => number;
}

export function createRuntime(): Runtime {
  return {
    busy: false,
    busySince: 0,
    toolCalls: new Set(),
    tokens: 0,
    tokensDone: 0,
    tps: [],
    tpsAt: 0,
    paneFocused: true,
    now: () => Date.now(),
  };
}

/** Context left in percent, or undefined when pi doesn't know yet. */
export function contextLeft(rt: Runtime): number | undefined {
  if (rt.preview === 'nearFull') return 8;
  const usage = rt.ctx?.getContextUsage();
  if (!usage || usage.percent == null) return undefined;
  return Math.max(0, Math.round(100 - usage.percent));
}

/** Colour of the context meter: checkpoint's policy colour when it publishes one. */
export function contextColor(rt: Runtime, left: number): ContextColor {
  if (rt.preview === 'nearFull') return 'error';
  return rt.contextColor ?? (left > 50 ? 'success' : left > 20 ? 'warning' : 'error');
}

export function isScrolledBack(rt: Runtime): boolean {
  const tui = rt.tui as (TUI & { isFollowingOutput?: boolean; mode?: string }) | undefined;
  return tui?.mode === 'fullscreen' && tui.isFollowingOutput === false;
}

/** Every visual state that currently applies, lowest precedence first. */
export function activeStates(rt: Runtime): StateName[] {
  if (rt.preview) return rt.preview === 'idle' ? ['idle'] : ['idle', rt.preview];
  const states: StateName[] = ['idle'];
  const text = rt.editor?.getText() ?? '';
  if (text.length > 0) states.push('typing');
  if (text.includes('\n') || (rt.editor?.pasteCount() ?? 0) > 0) states.push('paste');
  if (isScrolledBack(rt)) states.push('scrolled');
  const left = contextLeft(rt);
  if (
    rt.contextColor === 'warning' ||
    rt.contextColor === 'error' ||
    (rt.contextColor === undefined && left !== undefined && left < 15)
  )
    states.push('nearFull');
  if (rt.busy) states.push('working');
  if (rt.busy && rt.tool) states.push('tool');
  if (rt.prompt) states.push('prompt');
  return states;
}

/** Merge per-state overrides in precedence order. */
export function stateLook<T extends object>(
  states: StateName[],
  base: T,
  overrides: Partial<Record<StateName, Partial<T>>>,
): T {
  return states.reduce((look, s) => ({ ...look, ...overrides[s] }), base);
}

/** Resolve the magic colour "context" to the current context colour. */
export function resolveColor(rt: Runtime, color: string): string {
  if (color !== 'context') return color;
  const left = contextLeft(rt);
  return left === undefined ? 'warning' : contextColor(rt, left);
}

export function elapsed(rt: Runtime): number {
  return rt.busy ? rt.now() - rt.busySince : 0;
}

/** Record streamed output for the tokens and tps items. */
export function noteTokens(rt: Runtime, total: number): void {
  const delta = Math.max(0, total - rt.tokens);
  rt.tokens = total;
  const second = Math.floor(rt.now() / 1000);
  if (rt.tpsAt === 0) rt.tpsAt = second;
  while (rt.tpsAt < second) {
    rt.tps.push(0);
    rt.tpsAt++;
  }
  if (rt.tps.length === 0) rt.tps.push(0);
  rt.tps[rt.tps.length - 1]! += delta;
  if (rt.tps.length > 32) rt.tps.splice(0, rt.tps.length - 32);
}

export function resetRun(rt: Runtime): void {
  rt.tokens = 0;
  rt.tokensDone = 0;
  rt.tps = [];
  rt.tpsAt = 0;
  rt.tool = undefined;
  rt.toolCalls.clear();
}

export type { ComposerConfig };
