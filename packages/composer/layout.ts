/**
 * Fitting items into a row. One rule for every row in every style:
 *
 *   When a row is too wide, the lowest-priority item gives way first: shorter
 *   forms, then truncation or removal, before the next item is touched. Then
 *   higher-priority items get fuller forms back while they fit, and elastic
 *   items (the context bar) take whatever width is left over.
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export interface Piece {
  /** Full form first, then progressively shorter forms. All ANSI-styled. */
  forms: string[];
  priority: number;
  /** Pieces sharing a group id are joined with the group separator. */
  group: number;
  /** Literal text (text:…); a row of only text pieces renders nothing. */
  isText?: boolean;
  /** Truncate to a width instead of dropping (labels, messages). Return '' if it can't fit. */
  shrink?: (width: number) => string;
  /** Grow into spare width; called with the extra cells available. */
  grow?: (extra: number) => string;
}

export interface FitOptions {
  separator: string;
  groupSeparator: string;
  /** Minimum cells between the left and right sides when both are present. */
  gap?: number;
}

export interface Fitted {
  left: string;
  right: string;
  /** Visible width of left + right (excluding the gap). */
  width: number;
}

interface Slot {
  piece: Piece;
  level: number; // index into forms; forms.length = dropped
  text?: string | undefined; // shrunk or grown override
}

const shown = (s: Slot) => s.level < s.piece.forms.length && current(s) !== '';
const current = (s: Slot) => s.text ?? s.piece.forms[s.level] ?? '';

function join(slots: Slot[], o: FitOptions): string {
  let out = '';
  let prev: Slot | undefined;
  for (const s of slots) {
    if (!shown(s)) continue;
    if (prev) out += prev.piece.group === s.piece.group ? o.groupSeparator : o.separator;
    out += current(s);
    prev = s;
  }
  return out;
}

/** Fit left- and right-aligned pieces into `width` cells. */
export function fitRow(left: Piece[], right: Piece[], width: number, o: FitOptions): Fitted {
  const gap = o.gap ?? 1;
  const L: Slot[] = left.map((piece) => ({ piece, level: 0 }));
  const R: Slot[] = right.map((piece) => ({ piece, level: 0 }));
  const all = [...L, ...R];
  const measure = () => {
    const l = visibleWidth(join(L, o));
    const r = visibleWidth(join(R, o));
    return l + r + (l > 0 && r > 0 ? gap : 0);
  };
  // Lowest priority first; on ties, the item further along its list goes first.
  const order = all
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.piece.priority - b.s.piece.priority || b.i - a.i)
    .map((x) => x.s);

  // The lowest-priority item shrinks first, one form at a time; when it has no
  // shorter form it truncates (if it can) or disappears. Then the next item.
  const shrinkInPlace = (s: Slot): boolean => {
    if (!s.piece.shrink || s.text !== undefined) return false;
    const keep = s.level;
    s.level = s.piece.forms.length;
    const without = measure();
    s.level = keep;
    const room = width - without - (without > 0 ? visibleWidth(o.separator) : 0);
    const shrunk = room >= 4 ? s.piece.shrink(room) : '';
    if (!shrunk || visibleWidth(shrunk) > room) return false;
    s.text = shrunk;
    return true;
  };
  for (const s of order) {
    while (measure() > width && s.level < s.piece.forms.length) {
      if (s.level < s.piece.forms.length - 1 && s.text === undefined) s.level++;
      else if (!shrinkInPlace(s)) {
        s.text = undefined;
        s.level = s.piece.forms.length;
      }
    }
    if (measure() <= width) break;
  }
  // Give space back: restore fuller forms, highest priority first, while they fit.
  for (const s of [...order].reverse()) {
    if (s.text !== undefined) continue;
    while (s.level > 0) {
      s.level--;
      if (measure() <= width) continue;
      s.level++;
      break;
    }
  }
  // A row whose only survivors are literal text says nothing on its own.
  if (!all.some((s) => shown(s) && !s.piece.isText)) return { left: '', right: '', width: 0 };
  // Elastic pieces take the spare width (only in their full form).
  const spare = width - measure();
  if (spare > 0) {
    const elastic = all.find((s) => s.level === 0 && s.piece.grow && s.text === undefined);
    if (elastic) elastic.text = elastic.piece.grow!(spare);
  }
  let l = join(L, o);
  let r = join(R, o);
  // Last-resort guard: never exceed the width, whatever an item reported.
  if (visibleWidth(l) + visibleWidth(r) > width) {
    clipStats.count++;
    r = '';
    l = truncateToWidth(l, width);
  }
  return { left: l, right: r, width: visibleWidth(l) + visibleWidth(r) };
}

/** Lay out a fitted row as `left … right` padded with `fill` to exactly `width`. */
export function spread(f: Fitted, width: number, fill = ' '): string {
  const pad = Math.max(0, width - f.width);
  return f.left + fill.repeat(pad) + f.right;
}

/** How many times a row had to be clipped. Tests assert this stays 0. */
export const clipStats = { count: 0 };

/** Pad or clip a styled line to exactly `width` cells. */
export function exact(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w > width) {
    clipStats.count++;
    return truncateToWidth(line, width, '');
  }
  return line + ' '.repeat(width - w);
}
