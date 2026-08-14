/**
 * Shimmer rendering + config for the spinner working message.
 *
 * Renders one frame of a Claude Code-style shimmer: the message text sits in
 * a base colour while a highlight band sweeps left → right, positioned by
 * wall-clock time. Only the text shimmers — the spinner glyph next to it is a
 * separate segment of pi's Loader and is never touched.
 *
 * Config is loaded once at extension load from <agent-dir>/configs/spinner.json.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';

export const DEFAULT_CONFIG = {
  /** Sweep a highlight across the working-message text while the agent works. */
  SHIMMER: true,
  /** Milliseconds between shimmer frames. */
  SHIMMER_INTERVAL_MS: 80,
  /** Milliseconds for one full left-to-right sweep. */
  SHIMMER_PERIOD_MS: 2000,
  /** Theme colour token or hex for the resting text (pi paints the working
   * message "muted" by default, so that is the seamless choice). */
  BASE_COLOR: 'muted',
  /** Theme colour token or hex the highlight sweeps toward. */
  HIGHLIGHT_COLOR: 'text',
  /** Width of the highlight band, in characters. */
  BAND_WIDTH: 6,
  /** Hide the spinner glyph entirely, leaving only the working-message text. */
  HIDE_SPINNER: false,
};

interface SpinnerUserConfig {
  shimmer?: boolean;
  shimmerIntervalMs?: number;
  shimmerPeriodMs?: number;
  baseColor?: string;
  highlightColor?: string;
  bandWidth?: number;
  hideSpinner?: boolean;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

function loadConfig() {
  let user: SpinnerUserConfig = {};
  try {
    user = JSON.parse(readFileSync(join(getAgentDir(), 'configs', 'spinner.json'), 'utf8'));
  } catch {
    // Missing or malformed config — run with defaults.
  }
  return {
    SHIMMER: typeof user.shimmer === 'boolean' ? user.shimmer : DEFAULT_CONFIG.SHIMMER,
    SHIMMER_INTERVAL_MS: positiveNumber(user.shimmerIntervalMs, DEFAULT_CONFIG.SHIMMER_INTERVAL_MS),
    SHIMMER_PERIOD_MS: positiveNumber(user.shimmerPeriodMs, DEFAULT_CONFIG.SHIMMER_PERIOD_MS),
    BASE_COLOR: typeof user.baseColor === 'string' ? user.baseColor : DEFAULT_CONFIG.BASE_COLOR,
    HIGHLIGHT_COLOR: typeof user.highlightColor === 'string' ? user.highlightColor : DEFAULT_CONFIG.HIGHLIGHT_COLOR,
    BAND_WIDTH: positiveNumber(user.bandWidth, DEFAULT_CONFIG.BAND_WIDTH),
    HIDE_SPINNER: typeof user.hideSpinner === 'boolean' ? user.hideSpinner : DEFAULT_CONFIG.HIDE_SPINNER,
  };
}

export const CONFIG = loadConfig();

// ─── colour helpers ────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb | null {
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Resolve a theme token or hex colour to RGB. Returns null when the theme
 * doesn't emit a truecolor sequence for the token (e.g. 256-colour themes). */
function resolveRgb(theme: Theme, color: string): Rgb | null {
  if (color.startsWith('#')) return hexToRgb(color);
  try {
    const painted = theme.fg(color as ThemeColor, 'x');
    const m = painted.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  } catch {
    /* unknown token */
  }
  return null;
}

/** Paint text with a theme token or hex colour; unknown colours pass through. */
function paint(theme: Theme, color: string, text: string): string {
  if (color.startsWith('#')) {
    const rgb = hexToRgb(color);
    return rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m` : text;
  }
  try {
    return theme.fg(color as ThemeColor, text);
  } catch {
    return text;
  }
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Render one shimmer frame of `text` for the given wall-clock time. Every
 * character carries an explicit foreground colour so the frame looks the same
 * regardless of the colour the loader wraps around the message.
 */
export function shimmerFrame(text: string, theme: Theme, now = Date.now()): string {
  const chars = [...text];
  const band = CONFIG.BAND_WIDTH;
  // The band starts fully off-screen left and exits fully off-screen right.
  const cycle = chars.length + band * 2;
  const head = ((now % CONFIG.SHIMMER_PERIOD_MS) / CONFIG.SHIMMER_PERIOD_MS) * cycle - band;

  const base = resolveRgb(theme, CONFIG.BASE_COLOR);
  const highlight = resolveRgb(theme, CONFIG.HIGHLIGHT_COLOR);

  // Non-truecolor theme: fall back to a two-tone band using theme tokens.
  if (!base || !highlight) {
    return chars
      .map((ch, i) =>
        ch === ' ' ? ch : paint(theme, Math.abs(i - head) <= band / 2 ? CONFIG.HIGHLIGHT_COLOR : CONFIG.BASE_COLOR, ch),
      )
      .join('');
  }

  const painted = chars
    .map((ch, i) => {
      if (ch === ' ') return ch;
      const t = Math.max(0, 1 - Math.abs(i - head) / band);
      const eased = t * t * (3 - 2 * t); // smoothstep falloff
      const [r, g, b] = mixRgb(base, highlight, eased);
      return `\x1b[38;2;${r};${g};${b}m${ch}`;
    })
    .join('');
  return `${painted}\x1b[0m`;
}
