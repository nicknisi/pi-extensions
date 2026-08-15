import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escapes so we can inspect a rendered line's visible characters. */
export function plainText(line: string): string {
  return line.replace(ANSI_RE, '');
}

/** Split a `{name}` format template into its literal pre/post parts. Assumes
 * the template contains `{name}` (config validation enforces this); a
 * template without it degrades to rendering the bare name. */
export function splitFormat(format: string): [string, string] {
  const i = format.indexOf('{name}');
  if (i === -1) return ['', ''];
  return [format.slice(0, i), format.slice(i + '{name}'.length)];
}

/** Parse a `composer:set-label` bus payload: a non-empty string `text` sets
 * the label; anything else (absent, empty, wrong type) clears the override. */
export function parseLabelData(data: unknown): string | undefined {
  const text = (data as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' && text.trim().length > 0 ? text : undefined;
}

/** Whether this tmux pane is selected by a focused client. */
export function paneHasFocusedClient(paneId: string | undefined, clients: string): boolean {
  if (paneId === undefined) return true;
  return clients.split(/\r?\n/).some((line) => {
    const [flags, selectedPane] = line.split('\t');
    return selectedPane === paneId && flags?.split(',').includes('focused');
  });
}

/** Read terminal focus events from raw stdin, preserving a split CSI prefix. */
export function parseFocusInput(carry: string, chunk: string): { focused: boolean | undefined; carry: string } {
  const input = carry + chunk;
  const focusIn = input.lastIndexOf('\x1b[I');
  const focusOut = input.lastIndexOf('\x1b[O');
  return {
    focused: focusIn === -1 && focusOut === -1 ? undefined : focusIn > focusOut,
    carry: input.endsWith('\x1b[') ? '\x1b[' : input.endsWith('\x1b') ? '\x1b' : '',
  };
}

/** Truncate to `max` visible cells, appending an ellipsis when truncated. */
export function truncateCells(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = visibleWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function isHexColor(color: string): boolean {
  return color.startsWith('#');
}

function hexToAnsi(hex: string): string {
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return '';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb | null {
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Resolve a theme token or hex colour to RGB. Returns null when the theme
 * doesn't emit a truecolor sequence for the token (e.g. 256-colour themes). */
export function resolveRgb(theme: Theme, color: string): Rgb | null {
  if (isHexColor(color)) return hexToRgb(color);
  try {
    const painted = theme.fg(color as ThemeColor, 'x');
    const m = painted.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  } catch {
    /* unknown token */
  }
  return null;
}

/** Linear mix of two RGB colours; t=0 gives `a`, t=1 gives `b`. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Fully saturated rainbow colour, hue-rotating once per `periodMs`. */
export function rainbowRgb(periodMs: number): Rgb {
  const h = ((Date.now() % periodMs) / periodMs) * 6; // hue in [0,6)
  const x = Math.round(255 * (1 - Math.abs((h % 2) - 1)));
  const sector = Math.floor(h);
  if (sector === 0) return [255, x, 0];
  if (sector === 1) return [x, 255, 0];
  if (sector === 2) return [0, 255, x];
  if (sector === 3) return [0, x, 255];
  if (sector === 4) return [x, 0, 255];
  return [255, 0, x];
}

/** Paint text with a truecolor foreground. */
export function rgbColor(rgb: Rgb, text: string): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`;
}

/** Apply a colour by theme token or hex value. Hex takes precedence. */
export function applyColor(theme: Theme, color: string, text: string): string {
  if (isHexColor(color)) {
    const seq = hexToAnsi(color);
    return seq ? `${seq}${text}\x1b[0m` : text;
  }
  try {
    return theme.fg(color as ThemeColor, text);
  } catch {
    return text;
  }
}
