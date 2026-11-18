/**
 * Pure rendering for every row composer owns: the box (or slab / bare
 * prompt), the side panel, the footer, and the row above the box. Takes the
 * resolved config and runtime state; the editor and footer components just
 * call in here, which keeps every style testable without a live TUI.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { spinnerFrames, type ComposerConfig, type SlotEntry, type StateName } from './config.js';
import { pieces, type ItemEnv } from './items.js';
import { exact, fitRow, spread, type FitOptions, type Piece } from './layout.js';
import { activeStates, resolveColor, stateLook, type Runtime } from './state.js';
import { applyColor, mixRgb, plainText, resolveRgb, rgbColor, type Rgb } from './utils.js';

const FRAMES = {
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', lb: '┤', rb: '├' },
  square: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', lb: '┤', rb: '├' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', lb: '┫', rb: '┣' },
} as const;

export interface Ctx {
  cfg: ComposerConfig;
  rt: Runtime;
  theme: Theme;
}

function env(c: Ctx, states = activeStates(c.rt)): ItemEnv {
  return { rt: c.rt, cfg: c.cfg, theme: c.theme, states };
}

function fitOpts(c: Ctx): FitOptions {
  return {
    separator: applyColor(c.theme, 'dim', c.cfg.separator),
    groupSeparator: applyColor(c.theme, 'dim', c.cfg.groupSeparator),
  };
}

const slot = (c: Ctx, e: ItemEnv, entries: SlotEntry[]): Piece[] => pieces(entries, e);

// ─── Prompt symbol ────────────────────────────────────────────────────────

/** Cell width reserved for the prompt symbol, so states and spinner frames never shift the text. */
export function promptWidth(cfg: ComposerConfig): number {
  const symbols = [cfg.prompt.symbol, ...Object.values(cfg.prompt.states).map((s) => s?.symbol ?? '')];
  if (cfg.prompt.whenBusy === 'spinner') symbols.push(...spinnerFrames(cfg).frames);
  return Math.max(0, ...symbols.map((s) => visibleWidth(s)));
}

function promptGlyph(c: Ctx, states: StateName[], width: number): string {
  if (width === 0) return '';
  const look = stateLook(states, { symbol: c.cfg.prompt.symbol, color: c.cfg.prompt.color }, c.cfg.prompt.states);
  const { frames, intervalMs } = spinnerFrames(c.cfg);
  const spinning = c.rt.busy && c.cfg.prompt.whenBusy === 'spinner' && frames.length > 0;
  const glyph = spinning
    ? frames[Math.floor((c.rt.now() - c.rt.busySince) / intervalMs) % frames.length]!
    : look.symbol;
  const color = spinning ? c.cfg.spinner.color : look.color;
  return applyColor(c.theme, resolveColor(c.rt, color), glyph) + ' '.repeat(Math.max(0, width - visibleWidth(glyph)));
}

// ─── Border colour and busy effects ───────────────────────────────────────

function hue(t: number): Rgb {
  const h = (((t % 1) + 1) % 1) * 6;
  const x = Math.round(255 * (1 - Math.abs((h % 2) - 1)));
  const sector = Math.floor(h);
  return (
    [
      [255, x, 0],
      [x, 255, 0],
      [0, 255, x],
      [0, x, 255],
      [x, 0, 255],
      [255, 0, x],
    ] as Rgb[]
  )[sector]!;
}

interface Painter {
  /** Paint border glyphs (corners, sides, short rule bits). */
  border(s: string): string;
  /** Paint a long horizontal run; busy effects (shimmer, rainbow) apply here. */
  run(s: string): string;
}

function painter(c: Ctx, states: StateName[]): Painter {
  const { box } = c.cfg;
  const base = c.cfg.box.focusColor && c.rt.paneFocused ? c.cfg.box.focusColor : box.color;
  const color = resolveColor(c.rt, stateLook(states, { color: base }, box.states).color ?? base);
  const plain = (s: string) => applyColor(c.theme, color, s);
  const busy = c.rt.busy && box.busyEffect !== 'off';
  const phase = (c.rt.now() % box.effectPeriodMs) / box.effectPeriodMs;
  if (!busy) return { border: plain, run: plain };
  if (box.busyEffect === 'pulse') {
    const from = resolveRgb(c.theme, color);
    const to = resolveRgb(c.theme, resolveColor(c.rt, box.effectColor));
    const t = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    const pulse = (s: string) =>
      from && to ? rgbColor(mixRgb(from, to, t), s) : applyColor(c.theme, box.effectColor, s);
    return { border: pulse, run: pulse };
  }
  if (box.busyEffect === 'rainbow')
    return {
      border: plain,
      run: (s) => [...s].map((ch, i, all) => rgbColor(hue(i / Math.max(1, all.length) - phase), ch)).join(''),
    };
  // shimmer: a highlight window sweeping left to right.
  return {
    border: plain,
    run: (s) => {
      const chars = [...s];
      const win = Math.max(3, Math.min(10, Math.floor(chars.length / 6)));
      const head = Math.floor(phase * (chars.length + win));
      return chars
        .map((ch, i) => (i < head && i >= head - win ? applyColor(c.theme, box.effectColor, ch) : plain(ch)))
        .join('');
    },
  };
}

// ─── Stock editor output ──────────────────────────────────────────────────

const isRuleChar = (line: string) => plainText(line).replace(/─/g, '').length === 0;
const scrollText = (line: string) => {
  const plain = plainText(line);
  return plain.startsWith('─') ? (/((?:↑|↓)\s*\d+\s*more)/.exec(plain)?.[1] ?? null) : null;
};
const isBorderLike = (line: string) => isRuleChar(line) || scrollText(line) !== null;

/** Split pi's stock editor render into text rows, menu rows and scroll hints. */
export function splitStock(stock: string[]): {
  rows: string[];
  menu: string[];
  topScroll: string | null;
  bottomScroll: string | null;
} | null {
  const first = stock.findIndex(isBorderLike);
  let last = -1;
  for (let i = stock.length - 1; i >= 0; i--)
    if (isBorderLike(stock[i]!)) {
      last = i;
      break;
    }
  if (first === -1 || last === first) return null;
  return {
    rows: stock.slice(first + 1, last),
    menu: stock.slice(last + 1),
    topScroll: scrollText(stock[first]!),
    bottomScroll: scrollText(stock[last]!),
  };
}

// ─── Editor ───────────────────────────────────────────────────────────────

export interface EditorGeometry {
  boxWidth: number;
  contentWidth: number;
  promptWidth: number;
  panel: boolean;
}

export function panelVisible(cfg: ComposerConfig, width: number): boolean {
  return cfg.slots.panel.length > 0 && width >= cfg.panel.minWidth;
}

export function geometry(cfg: ComposerConfig, width: number): EditorGeometry {
  const panel = panelVisible(cfg, width);
  const boxWidth = panel ? width - cfg.panel.width - 1 : width;
  const pw = promptWidth(cfg);
  const { border, padX } = cfg.box;
  const framed = border in FRAMES;
  const sides = framed ? 2 : 0;
  const rightPad = framed || border === 'slab' ? padX : 0;
  // The prompt symbol always gets at least one space before the text.
  const lead = padX + (pw > 0 ? pw + Math.max(1, padX) : 0);
  return { boxWidth, contentWidth: boxWidth - sides - lead - rightPad, promptWidth: pw, panel };
}

/**
 * Render the editor area. `stock` is pi's own editor render at
 * `geometry().contentWidth`; null means "too narrow, use the stock render".
 */
export function renderEditor(c: Ctx, width: number, stock: string[]): string[] | null {
  const g = geometry(c.cfg, width);
  if (g.contentWidth < 4) return null;
  const split = splitStock(stock);
  if (!split) return null;
  const states = activeStates(c.rt);
  const e = env(c, states);
  const { box } = c.cfg;
  const paint = painter(c, states);
  const pad = ' '.repeat(box.padX);
  const empty = (c.rt.editor?.getText() ?? '') === '' && !c.rt.preview;
  // /composer preview: show sample input for the typing and paste states.
  if (c.rt.preview && (c.rt.editor?.getText() ?? '') === '') {
    const sample = PREVIEW_TEXT[c.rt.preview];
    if (sample) split.rows = sample.map((t) => applyColor(c.theme, 'text', truncate(t, g.contentWidth)));
  }

  // Text rows: prompt symbol on the first, right prompt and placeholder on the first.
  const rp = slot(c, e, c.cfg.slots.rightPrompt);
  const text = split.rows.map((row, i) => {
    let content = exact(row, g.contentWidth);
    if (i === 0) {
      const trimmed = trimEnd(row);
      const used = visibleWidth(trimmed);
      if (empty && box.placeholder) {
        // Right after the cursor cell, where typed text would start.
        const room = g.contentWidth - used;
        if (room > 3)
          content = exact(`${trimmed}${applyColor(c.theme, 'dim', truncate(box.placeholder, room))}`, g.contentWidth);
      }
      if (rp.length) {
        const f = fitRow([], rp, g.contentWidth - used - 2, fitOpts(c));
        if (f.width > 0) content = `${exact(trimmed, g.contentWidth - f.width)}${f.right}`;
      }
    }
    const gap = ' '.repeat(Math.max(1, box.padX));
    const symbol =
      g.promptWidth > 0 ? (i === 0 ? promptGlyph(c, states, g.promptWidth) : ' '.repeat(g.promptWidth)) + gap : '';
    return pad + symbol + content;
  });
  const blank =
    pad + (g.promptWidth > 0 ? ' '.repeat(g.promptWidth + Math.max(1, box.padX)) : '') + ' '.repeat(g.contentWidth);
  const panelRows = g.panel ? Math.min(3, slot(c, e, c.cfg.slots.panel).length) : 0;
  while (text.length < panelRows) text.push(blank);
  const body = [...Array(box.padY).fill(blank), ...text, ...Array(box.padY).fill(blank)];

  const top = (inner: number, scroll: string | null) =>
    rule(c, e, paint, inner, withScroll(c, e, c.cfg.slots.topLeft, scroll), slot(c, e, c.cfg.slots.topRight), true);
  const bottom = (inner: number, scroll: string | null) =>
    rule(
      c,
      e,
      paint,
      inner,
      withScroll(c, e, c.cfg.slots.bottomLeft, scroll),
      slot(c, e, c.cfg.slots.bottomRight),
      false,
    );

  let lines: string[];
  if (box.border in FRAMES) {
    const f = FRAMES[box.border as keyof typeof FRAMES];
    const inner = g.boxWidth - 2;
    lines = [
      paint.border(f.tl) + top(inner, split.topScroll) + paint.border(f.tr),
      ...body.map((row) => paint.border(f.v) + row + pad + paint.border(f.v)),
      paint.border(f.bl) + bottom(inner, split.bottomScroll) + paint.border(f.br),
    ];
  } else if (box.border === 'rule') {
    lines = [top(g.boxWidth, split.topScroll), ...body, bottom(g.boxWidth, split.bottomScroll)];
  } else if (box.border === 'slab') {
    const bg = (s: string) => slabRow(c, exact(s, g.boxWidth));
    const edge = (left: Piece[], right: Piece[]) =>
      bg(` ${spread(fitRow(left, right, g.boxWidth - 2, fitOpts(c)), g.boxWidth - 2)} `);
    lines = [
      edge(withScroll(c, e, c.cfg.slots.topLeft, split.topScroll), slot(c, e, c.cfg.slots.topRight)),
      ...body.map((row) => bg(row + pad)),
      edge(withScroll(c, e, c.cfg.slots.bottomLeft, split.bottomScroll), slot(c, e, c.cfg.slots.bottomRight)),
    ];
  } else {
    // none: bare prompt, with optional rows above/below when those slots have content.
    const edge = (left: Piece[], right: Piece[]) => {
      const f = fitRow(left, right, g.boxWidth - 1, fitOpts(c));
      return f.width > 0 ? [` ${spread(f, g.boxWidth - 1)}`] : [];
    };
    lines = [
      ...edge(withScroll(c, e, c.cfg.slots.topLeft, split.topScroll), slot(c, e, c.cfg.slots.topRight)),
      ...body,
      ...edge(withScroll(c, e, c.cfg.slots.bottomLeft, split.bottomScroll), slot(c, e, c.cfg.slots.bottomRight)),
    ];
  }
  lines = lines.map((l) => exact(l, g.boxWidth));

  if (g.panel) {
    const panel = renderPanel(c, e, paint, c.cfg.panel.width, lines.length);
    lines = lines.map((l, i) => `${l} ${panel[i] ?? ''}`);
  }

  const gap = Array<string>(box.menuGap).fill('');
  const indent = ' '.repeat(box.menuIndent);
  const menu = split.menu.map((m) => exact(indent + m, width));
  return [...lines.map((l) => exact(l, width)), ...gap, ...menu];
}

/** Drop trailing spaces, including ones sitting before trailing SGR codes. */
function trimEnd(line: string): string {
  return line.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, '$1');
}

const PREVIEW_TEXT: Partial<Record<StateName, string[]>> = {
  typing: ['refactor the footer so the context bar never disappears'],
  paste: ['here is the failing output:', '[paste #1 +42 lines]', 'why does the bar vanish at 40 columns?'],
};

function truncate(s: string, w: number): string {
  return visibleWidth(s) <= w ? s : `${[...s].slice(0, Math.max(0, w - 1)).join('')}…`;
}

/** Pi's "↑ 3 more" scroll hint rides along as the top-priority inlay. */
function withScroll(c: Ctx, e: ItemEnv, entries: SlotEntry[], scroll: string | null): Piece[] {
  const list = slot(c, e, entries);
  return scroll ? [{ forms: [applyColor(c.theme, 'dim', scroll)], priority: 1000, group: -1 }, ...list] : list;
}

/** A horizontal border with inlays, exactly `inner` cells. */
function rule(
  c: Ctx,
  _e: ItemEnv,
  paint: Painter,
  inner: number,
  left: Piece[],
  right: Piece[],
  isTop: boolean,
): string {
  const h = c.cfg.box.border === 'heavy' ? '━' : '─';
  const brackets = c.cfg.box.inlay === 'bracket';
  const f = FRAMES[c.cfg.box.border as keyof typeof FRAMES] ?? FRAMES.rounded;
  const wrap = (s: string) => (!s ? '' : brackets ? paint.border(f.lb) + s + paint.border(f.rb) : ` ${s} `);
  const fitted = fitRow(left, right, Math.max(0, inner - 6), fitOpts(c));
  const l = wrap(fitted.left);
  const r = wrap(fitted.right);
  const fill = Math.max(0, inner - 2 - visibleWidth(l) - visibleWidth(r));
  const run = isTop ? paint.run : paint.border;
  return paint.border(h) + l + run(h.repeat(fill)) + r + paint.border(h);
}

function slabRow(c: Ctx, line: string): string {
  let open = '';
  try {
    open = c.theme.bg(c.cfg.box.background as Parameters<Theme['bg']>[0], '\u0000').split('\u0000')[0] ?? '';
  } catch {
    // Not a background token this theme knows: draw the slab without a background.
  }
  // Re-open the background after any reset inside the row (cursor, coloured text).
  return open + line.replace(/\x1b\[0m/g, `\x1b[0m${open}`).replace(/\x1b\[49m/g, open) + '\x1b[49m';
}

// ─── Side panel ───────────────────────────────────────────────────────────

function renderPanel(c: Ctx, e: ItemEnv, paint: Painter, width: number, height: number): string[] {
  const inner = width - 2;
  const items = slot(c, e, c.cfg.slots.panel);
  const rows = Math.max(0, height - 2);
  // Keep the highest-priority items, in list order.
  const keep = new Set([...items].sort((a, b) => b.priority - a.priority).slice(0, rows));
  const shown = items.filter((p) => keep.has(p));
  const body = Array.from({ length: rows }, (_, i) => {
    const p = shown[i];
    let s = '';
    if (p) {
      const full = p.forms[0] ?? '';
      const room = inner - 2;
      s = p.grow && visibleWidth(full) < room ? p.grow(room - visibleWidth(full)) : full;
      if (visibleWidth(s) > room) s = p.forms.find((x) => visibleWidth(x) <= room) ?? '';
    }
    return paint.border('│') + ' ' + exact(s, inner - 2) + ' ' + paint.border('│');
  });
  const title = (entries: SlotEntry[], isTop: boolean) => {
    const f = fitRow(slot(c, e, entries), [], inner - 4, fitOpts(c));
    const t = f.width ? paint.border('┤') + f.left + paint.border('├') : '';
    const fill = Math.max(0, inner - 1 - visibleWidth(t));
    return isTop
      ? paint.border('─') + t + paint.border('─'.repeat(fill))
      : paint.border('─'.repeat(fill)) + t + paint.border('─');
  };
  return [
    paint.border('╭') + title(c.cfg.slots.panelTop, true) + paint.border('╮'),
    ...body,
    paint.border('╰') + title(c.cfg.slots.panelBottom, false) + paint.border('╯'),
  ].map((l) => exact(l, width));
}

// ─── Footer and the row above ─────────────────────────────────────────────

export function renderFooter(c: Ctx, width: number): string[] {
  const e = env(c);
  let left = slot(c, e, c.cfg.slots.footerLeft);
  const right = slot(c, e, c.cfg.slots.footerRight);
  // Panel items fall back to the footer when the pane is too narrow for the panel.
  if (!panelVisible(c.cfg, width))
    left = [...left, ...slot(c, e, [...c.cfg.slots.panelTop, ...c.cfg.slots.panel, ...c.cfg.slots.panelBottom])];
  const toast = c.cfg.toasts && c.rt.toast && c.rt.toast.until > c.rt.now() ? c.rt.toast.text : undefined;
  if (toast) left = [{ forms: [toast], priority: 1000, group: -1 }];
  if (!left.length && !right.length) return [];
  const f = fitRow(left, right, width - 2, fitOpts(c));
  if (f.width === 0) return [];
  return [exact(` ${spread(f, width - 2)} `, width)];
}

export function renderAbove(c: Ctx, width: number): string[] {
  const list = slot(c, env(c), c.cfg.slots.above);
  if (!list.length) return [];
  const f = fitRow(list, [], width - 1, fitOpts(c));
  return f.width ? [exact(` ${f.left}`, width)] : [];
}
