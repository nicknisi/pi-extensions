/**
 * The item catalog. Each item turns runtime state into a Piece: a full form
 * plus shorter forms the fitter can fall back to, a default priority, and an
 * optional shrink/grow. Items with nothing to say return null and take no
 * space (cost before any spend, branch outside git, working while idle).
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { getKeybindings, hyperlink, visibleWidth } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import type { ComposerConfig, ItemName, ItemOptions, SlotEntry, StateName } from './config.js';
import { computeTotals, getPr, getUsage, timeUntil, type Totals } from './data.js';
import type { Piece } from './layout.js';
import {
  activeStates,
  contextColor,
  contextLeft,
  elapsed,
  isScrolledBack,
  resolveColor,
  type Runtime,
} from './state.js';
import { applyColor, truncateCells } from './utils.js';

export const DEFAULT_PRIORITY: Record<ItemName, number> = {
  working: 95,
  scroll: 92,
  mode: 90,
  context: 88,
  elapsed: 85,
  model: 80,
  paste: 78,
  thinking: 70,
  label: 65,
  pr: 55,
  branch: 50,
  tokens: 48,
  statuses: 45,
  cwd: 45,
  hints: 40,
  tps: 35,
  cost: 30,
  lines: 25,
  usage: 20,
};

const NERD: Partial<Record<ItemName, [string, string]>> = {
  cost: ['\u{F155}', 'success'],
  lines: ['\u{F440}', 'accent'],
  usage: ['\u{F0241}', 'warning'],
  context: ['\u{F09D1}', 'accent'],
  branch: ['\u{E725}', 'success'],
};
const UNICODE: Partial<Record<ItemName, string>> = { model: '◆', branch: '⎇' };

export interface ItemEnv {
  rt: Runtime;
  cfg: ComposerConfig;
  theme: Theme;
  states: StateName[];
}

const paint = (env: ItemEnv, color: string | undefined, s: string) =>
  color ? applyColor(env.theme, resolveColor(env.rt, color), s) : s;
const dim = (env: ItemEnv, s: string) => paint(env, 'dim', s);

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** `━━━━╌╌` meter of `percent` remaining, `width` cells. */
export function bar(env: ItemEnv, percent: number, width: number, color: string): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent * width) / 100)));
  return paint(env, color, '━'.repeat(filled) + '╌'.repeat(width - filled));
}

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(values: number[]): string {
  const max = Math.max(1, ...values);
  return values.map((v) => SPARK[Math.min(7, Math.round((v / max) * 7))]).join('');
}

/** First key bound to `action`: pi's injected keybindings first, the global manager as a fallback. */
function keyFor(rt: Runtime, action: string, fallback: string): string {
  try {
    const manager = rt.keybindings ?? getKeybindings();
    return (manager.getKeys as (a: string) => string[])(action)[0] ?? fallback;
  } catch {
    return fallback;
  }
}

/** Key hints for the current state: [key, what it does]. */
function hintsFor(states: StateName[], rt: Runtime): [string, string][] {
  const top = states[states.length - 1];
  const interrupt = keyFor(rt, 'app.interrupt', 'esc');
  switch (top) {
    case 'prompt':
      return []; // pi's dialog shows its own keys
    case 'tool':
    case 'working':
      return [
        [interrupt, 'interrupt'],
        ['enter', 'steer'],
        [keyFor(rt, 'app.message.followUp', 'alt+enter'), 'follow-up'],
        [keyFor(rt, 'app.tools.expand', 'ctrl+o'), 'expand'],
      ];
    case 'nearFull':
      return [
        ['/compact', 'free context'],
        ['enter', 'send'],
      ];
    case 'scrolled':
      return [
        [keyFor(rt, 'tui.altScreen.bottom', 'ctrl+end'), 'follow'],
        [keyFor(rt, 'tui.altScreen.pageUp', 'pgup'), 'scroll'],
      ];
    case 'paste':
      return [
        ['enter', 'send'],
        ['paste again', 'expand'],
        [keyFor(rt, 'tui.input.newLine', 'shift+enter'), 'newline'],
      ];
    case 'typing':
      return [
        ['enter', 'send'],
        [keyFor(rt, 'tui.input.newLine', 'shift+enter'), 'newline'],
      ];
    default:
      return [
        ['/', 'commands'],
        ['@', 'files'],
        ['!', 'shell'],
      ];
  }
}

const MODE: Record<StateName, [string, string]> = {
  idle: ['READY', 'muted'],
  typing: ['INSERT', 'accent'],
  paste: ['PASTE', 'success'],
  scrolled: ['SCROLL', 'muted'],
  nearFull: ['FULL', 'error'],
  working: ['WORKING', 'thinkingMax'],
  tool: ['TOOL', 'accent'],
  prompt: ['ASK', 'warning'],
};

// Session totals walk every entry, so cache them by branch length (and 5s).
let totalsCache: { count: number; at: number; totals: Totals } | undefined;
function totals(rt: Runtime): Totals {
  const entries = rt.ctx?.sessionManager.getBranch() ?? [];
  const now = rt.now();
  if (!totalsCache || totalsCache.count !== entries.length || now - totalsCache.at > 5000)
    totalsCache = { count: entries.length, at: now, totals: computeTotals(entries) };
  return totalsCache.totals;
}

interface Body {
  forms: string[];
  shrink?: (w: number) => string;
  grow?: (extra: number) => string;
  isText?: boolean;
}

/** The item's content, before icon/prefix/suffix decoration. */
function body(name: string, o: ItemOptions, env: ItemEnv): Body | null {
  const { rt } = env;
  if (name.startsWith('text:')) return { forms: [dim(env, name.slice(5))], isText: true };
  if (name.startsWith('status:')) {
    const text = rt.footerData?.getExtensionStatuses().get(name.slice(7));
    return text ? { forms: [sanitize(text)] } : null;
  }
  switch (name as ItemName) {
    case 'label': {
      const text = rt.labelOverride ?? rt.sessionName;
      if (!text) return null;
      return { forms: [paint(env, o.color, text)], shrink: (w) => paint(env, o.color, truncateCells(text, w)) };
    }
    case 'model': {
      const model = rt.ctx?.model;
      const name = (model?.name || model?.id || 'no model').replace(/ \(.*\)/, '');
      const short = name.replace(/^Claude /, '');
      const family = (/opus|sonnet|haiku/i.exec(name)?.[0] ?? short.split(' ')[0] ?? short).toLowerCase();
      return { forms: [name, short, family].map((t) => paint(env, o.color ?? 'accent', t)) };
    }
    case 'thinking': {
      if (!rt.ctx?.model?.reasoning || !rt.pi) return null;
      return { forms: [paint(env, o.color ?? 'dim', rt.pi.getThinkingLevel())] };
    }
    case 'cost': {
      const cost = totals(rt).cost;
      return cost > 0.001 ? { forms: [paint(env, o.color ?? 'dim', `$${cost.toFixed(2)}`)] } : null;
    }
    case 'lines': {
      const t = totals(rt);
      if (t.added === 0 && t.removed === 0) return null;
      return { forms: [`${paint(env, 'success', `+${t.added}`)}/${paint(env, 'error', `-${t.removed}`)}`] };
    }
    case 'usage': {
      const data = rt.ctx ? getUsage(rt.ctx) : undefined;
      if (!data?.five_hour || !data.seven_day) return null;
      const five = Math.max(0, Math.round(100 - data.five_hour.utilization));
      const seven = Math.max(0, Math.round(100 - data.seven_day.utilization));
      if (o.showBelow !== undefined && five >= o.showBelow && seven >= o.showBelow) return null;
      const col = (p: number) => (p > 50 ? 'success' : p > 20 ? 'warning' : 'error');
      const win = (label: string, p: number, resets: string) =>
        `${dim(env, label)} ${bar(env, p, 5, col(p))} ${p}% ${dim(env, `↻${timeUntil(resets)}`)}`;
      return {
        forms: [
          `${win('5h', five, data.five_hour.resets_at)} ${dim(env, '╱')} ${win('7d', seven, data.seven_day.resets_at)}`,
          `${dim(env, '5h')} ${paint(env, col(five), `${five}%`)} ${dim(env, '7d')} ${paint(env, col(seven), `${seven}%`)}`,
          `${dim(env, '5h')} ${paint(env, col(five), `${five}%`)}`,
        ],
      };
    }
    case 'context': {
      const left = contextLeft(rt) ?? 100;
      const color = contextColor(rt, left);
      const usage = rt.ctx?.getContextUsage();
      const tokens = usage?.tokens ?? 0;
      const label = o.label ?? 'ctx';
      const pct = `${left}%${label ? ` ${label}` : ''}`;
      const urgent = color === 'warning' || color === 'error';
      const pctPainted = urgent ? paint(env, color, pct) : paint(env, o.color, pct);
      const short = urgent ? paint(env, color, `${left}%`) : paint(env, o.color, `${left}%`);
      if (o.show === 'tokens') {
        const of = usage?.contextWindow ? `/${formatTokens(usage.contextWindow)}` : '';
        return { forms: [paint(env, o.color, `${formatTokens(tokens)}${of}`), short] };
      }
      if (o.show === 'percent') return { forms: [pctPainted, short] };
      const tokenStr = tokens > 0 ? dim(env, ` (${formatTokens(tokens)})`) : '';
      const max = o.barWidth ?? 20;
      const withBar = (w: number) => `${bar(env, left, w, color)} ${pctPainted}${tokenStr}`;
      const barOnly = `${bar(env, left, Math.min(5, max), color)} ${pctPainted}`;
      return {
        forms: [withBar(Math.min(5, max)), barOnly, pctPainted, short],
        grow: (extra) => withBar(Math.min(max, 5 + extra)),
      };
    }
    case 'branch': {
      const branch = rt.footerData?.getGitBranch();
      if (!branch) return null;
      return {
        forms: [paint(env, o.color ?? 'dim', branch)],
        shrink: (w) => paint(env, o.color ?? 'dim', truncateCells(branch, w)),
      };
    }
    case 'pr': {
      const branch = rt.footerData?.getGitBranch();
      const pr = branch && rt.ctx ? getPr(branch, rt.ctx.cwd) : null;
      return pr ? { forms: [hyperlink(paint(env, o.color ?? 'accent', `#${pr.number}`), pr.url)] } : null;
    }
    case 'cwd':
      return rt.ctx ? { forms: [paint(env, o.color ?? 'accent', basename(rt.ctx.cwd))] } : null;
    case 'statuses': {
      const hidden = new Set(o.hide ?? []);
      const list = [...(rt.footerData?.getExtensionStatuses().entries() ?? [])]
        .filter(([key]) => !hidden.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitize(text))
        .filter((text) => text.length > 0);
      if (list.length === 0) return null;
      const sep = env.cfg.separator;
      // Whole statuses before cut ones: "? ctrl+. to answer +1" reads better than two truncated halves.
      const more = list.length > 1 ? dim(env, ` +${list.length - 1}`) : '';
      return {
        forms: [list.join(sep), list[0]! + more, truncateStyled(list[0]!, 14) + more].filter(
          (f, i, all) => i === 0 || visibleWidth(f) < visibleWidth(all[i - 1]!),
        ),
      };
    }
    case 'working': {
      if (rt.indicator) {
        const ind = rt.indicator;
        return {
          forms: [ind.renderInBorder(400)],
          shrink: (w) => (w >= 8 ? ind.renderInBorder(w) : ind.renderSpinnerInBorder(w)),
        };
      }
      if (rt.preview === 'working' || rt.preview === 'tool')
        return { forms: [paint(env, o.color ?? 'muted', 'Previewing the working state')] };
      return null;
    }
    case 'elapsed':
      return rt.busy ? { forms: [paint(env, o.color ?? 'dim', formatDuration(elapsed(rt)))] } : null;
    case 'tokens': {
      if (!rt.busy || rt.tokens === 0) return null;
      const n = rt.tokens;
      return {
        forms: [
          `${paint(env, o.color ?? 'text', n.toLocaleString('en-US'))} ${dim(env, 'tokens')}`,
          `${paint(env, o.color ?? 'text', formatTokens(n))} ${dim(env, 'tok')}`,
        ],
      };
    }
    case 'tps': {
      if (!rt.busy || rt.tps.length < 2) return null;
      const rate = rt.tps[rt.tps.length - 2] ?? 0; // last complete second
      const rateStr = `${rate} tok/s`;
      return {
        forms: [
          `${paint(env, o.color ?? 'thinkingMax', sparkline(rt.tps.slice(-14)))} ${dim(env, rateStr)}`,
          dim(env, rateStr),
        ],
      };
    }
    case 'hints': {
      if (hintsFor(env.states, rt).length === 0) return null;
      // Plain text, as in the Codex footer: the key in muted, what it does in dim.
      const hints = hintsFor(env.states, rt).map(
        ([key, what]) => `${paint(env, o.color ?? 'muted', key)} ${dim(env, what)}`,
      );
      const sep = dim(env, ' · ');
      return { forms: [hints.join(sep), hints.slice(0, 2).join(sep), hints.slice(0, 1).join('')] };
    }
    case 'mode': {
      const top = env.states[env.states.length - 1] ?? 'idle';
      const [label, color] = MODE[top];
      const text = top === 'tool' && rt.tool ? rt.tool.name.toUpperCase() : label;
      return { forms: [`\x1b[7m${paint(env, o.color ?? color, ` ${text} `)}\x1b[27m`] };
    }
    case 'paste': {
      if (!env.states.includes('paste')) return null;
      const preview = rt.preview === 'paste'; // /composer preview's sample: 3 lines, 1 paste
      const lines = preview ? 3 : (rt.editor?.getText() ?? '').split('\n').length;
      const pastes = preview ? 1 : (rt.editor?.pasteCount() ?? 0);
      const parts = [
        `${lines} line${lines === 1 ? '' : 's'}`,
        ...(pastes ? [`${pastes} paste${pastes === 1 ? '' : 's'}`] : []),
      ];
      return { forms: [dim(env, parts.join(' · ')), dim(env, `${lines}L`)] };
    }
    case 'scroll': {
      if (!isScrolledBack(rt) && rt.preview !== 'scrolled') return null;
      const key = keyFor(rt, 'tui.altScreen.bottom', 'ctrl+end');
      return {
        forms: [
          paint(env, o.color ?? 'accent', `↓ scrolled · ${key} to follow`),
          paint(env, o.color ?? 'accent', `↓ ${key}`),
          paint(env, o.color ?? 'accent', '↓'),
        ],
      };
    }
  }
  return null;
}

/** Fold whitespace so a stray newline in an extension status can't break a row. */
function sanitize(text: string): string {
  return text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

/** Truncate styled text by visible width (keeps the leading SGR codes). */
function truncateStyled(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  // Status texts are short and usually one colour; strip, truncate, re-wrap the first SGR.
  const sgr = /^(\x1b\[[0-9;]*m)+/.exec(text)?.[0] ?? '';
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  return sgr ? `${sgr}${truncateCells(plain, max)}\x1b[0m` : truncateCells(plain, max);
}

function decorate(name: string, o: ItemOptions, env: ItemEnv, form: string): string {
  if (!form) return form;
  let icon = '';
  if (o.icon !== undefined) icon = o.icon ? paint(env, o.color, o.icon) : '';
  else if (env.cfg.icons === 'nerd' && NERD[name as ItemName]) {
    const [glyph, color] = NERD[name as ItemName]!;
    icon = paint(env, color, glyph);
  } else if (env.cfg.icons === 'nerd' && name === 'model') icon = modelIcon(env);
  else if (env.cfg.icons === 'unicode' && UNICODE[name as ItemName])
    icon = paint(env, o.color, UNICODE[name as ItemName]!);
  const pre = o.prefix ? dim(env, o.prefix) : '';
  const post = o.suffix ? dim(env, o.suffix) : '';
  return `${pre}${icon ? `${icon} ` : ''}${form}${post}`;
}

function modelIcon(env: ItemEnv): string {
  const lower = (env.rt.ctx?.model?.name ?? env.rt.ctx?.model?.id ?? '').toLowerCase();
  if (lower.includes('opus')) return paint(env, 'accent', '\u{F01E5}');
  if (lower.includes('sonnet')) return paint(env, 'accent', '\u{F075A}');
  if (lower.includes('haiku')) return paint(env, 'success', '\u{F0735}');
  return paint(env, 'dim', '\u{F06A9}');
}

/** Turn a slot's entries into pieces. Group members share a group id. */
export function pieces(entries: SlotEntry[], env: ItemEnv): Piece[] {
  const out: Piece[] = [];
  entries.forEach((entry, group) => {
    for (const name of Array.isArray(entry) ? entry : [entry]) {
      const o: ItemOptions = env.cfg.items[name as ItemName] ?? {};
      const b = body(name, o, env);
      if (!b) continue;
      const deco = (s: string) => decorate(name, o, env, s);
      out.push({
        forms: b.forms.map(deco),
        priority: o.priority ?? DEFAULT_PRIORITY[name as ItemName] ?? 5,
        group,
        ...(b.isText ? { isText: true } : {}),
        ...(b.shrink ? { shrink: (w: number) => fitDecorated(deco, b.shrink!, w) } : {}),
        ...(b.grow ? { grow: (extra: number) => deco(b.grow!(extra)) } : {}),
      });
    }
  });
  return out;
}

/** Shrink the body so that the decorated result fits `w`. */
function fitDecorated(deco: (s: string) => string, shrink: (w: number) => string, w: number): string {
  const overhead = visibleWidth(deco('x')) - 1;
  const inner = w - overhead;
  return inner >= 3 ? deco(shrink(inner)) : '';
}

export { activeStates };
