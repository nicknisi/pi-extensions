/** Config for composer — loaded once at extension load from <agent-dir>/configs/composer.json. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const DEFAULT_CONFIG = {
  /** Full box with side borders, or top/bottom horizontal rules only. */
  BOXED_VIEW: true,
  /** Horizontal padding inside the box (and around the prefix). */
  BOX_PAD_X: 1,
  /** Blank lines between the bottom border and the slash-menu. */
  MENU_GAP: 0,
  /** Extra indent (spaces) for slash-menu lines. */
  EXTRA_MENU_INDENT: 1,
  /** Theme colour token or hex for the box border. */
  BORDER_COLOR: 'border',
  /** Prefix glyph shown on the first body line. */
  PREFIX: '❯',
  /** Theme colour token or hex for the prefix. */
  PREFIX_COLOR: 'accent',
  /** Corner style: "rounded" (╭╮│╰╯) or "square" (┌┐│└┘). */
  CORNERS: 'rounded' as const,
  /** Restyle the border when this pane has terminal focus (needs tmux focus-events). */
  FOCUS_INDICATOR: true,
  /** Theme colour token or hex for the border while the pane is focused. */
  FOCUSED_BORDER_COLOR: 'accent',
  /** Animate the prefix glyph as a spinner while the agent is working. */
  SPINNER: true,
  /** Built-in spinner preset (see SPINNERS). Custom spinnerFrames override it. */
  SPINNER_STYLE: 'dots' as SpinnerStyle,
  /** Theme colour token, hex, or "rainbow" for the spinner. */
  SPINNER_COLOR: 'accent',
  /** Animate the border while the agent is working. */
  GLOW: true,
  /** "pulse" breathes the border colour; "shimmer" sweeps a highlight along the rules. */
  GLOW_STYLE: 'pulse' as 'pulse' | 'shimmer',
  /** Theme colour token, hex, or "rainbow" the glow animates toward. */
  GLOW_COLOR: 'accent',
  /** Milliseconds per glow cycle. */
  GLOW_PERIOD_MS: 2000,
  /** Milliseconds per full hue rotation for "rainbow" colours. */
  RAINBOW_PERIOD_MS: 1200,
};

/** Built-in spinner presets. Frames may be any cell width — the prefix slot
 * is sized to the widest frame of the active spinner. Each preset carries a
 * tuned default interval, overridable with spinnerIntervalMs. */
export const SPINNERS = {
  /** Classic braille dots (pi-style). */
  dots: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], intervalMs: 80 },
  /** Dense braille disc with an orbiting gap. */
  disc: { frames: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'], intervalMs: 90 },
  /** Moon phases (emoji, 2 cells wide). */
  moon: { frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'], intervalMs: 90 },
  /** Twinkling star — flares and dims rather than spinning. */
  star: { frames: ['✶', '✸', '✹', '✺', '✹', '✸'], intervalMs: 90 },
  /** A dot orbiting a circle. */
  orbit: { frames: ['◜', '◠', '◝', '◞', '◡', '◟'], intervalMs: 80 },
  /** A quarter-block bouncing around the corners of the cell. */
  corners: { frames: ['▖', '▘', '▝', '▗'], intervalMs: 120 },
  /** A spinning filled triangle. */
  triangle: { frames: ['◢', '◣', '◤', '◥'], intervalMs: 120 },
  /** KITT scanner — a comet with a fading tail bouncing across 6 cells. */
  scanner: {
    frames: [
      '●·····',
      '•●····',
      '·•●···',
      '··•●··',
      '···•●·',
      '····•●',
      '·····●',
      '····●•',
      '···●•·',
      '··●•··',
      '·●•···',
      '●•····',
    ],
    intervalMs: 60,
  },
  /** Scanner's little sibling — 3 cells, no tail. */
  'mini-scanner': { frames: ['●··', '·●·', '··●', '·●·'], intervalMs: 120 },
} as const;

export type SpinnerStyle = keyof typeof SPINNERS;

function isSpinnerStyle(s: unknown): s is SpinnerStyle {
  return typeof s === 'string' && s in SPINNERS;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

interface ComposerUserConfig {
  boxedView?: boolean;
  boxPadX?: number;
  menuGap?: number;
  extraMenuIndent?: number;
  borderColor?: string;
  prefix?: string;
  prefixColor?: string;
  corners?: 'rounded' | 'square';
  focusIndicator?: boolean;
  focusedBorderColor?: string;
  spinner?: boolean;
  spinnerStyle?: SpinnerStyle;
  spinnerFrames?: string[];
  spinnerIntervalMs?: number;
  spinnerColor?: string;
  glow?: boolean;
  glowStyle?: 'pulse' | 'shimmer';
  glowColor?: string;
  glowPeriodMs?: number;
  rainbowPeriodMs?: number;
}

const CONFIG_PATH = join(getAgentDir(), 'configs', 'composer.json');

/** Read the user config. `error` is set only for real problems (bad JSON,
 * unreadable file) — a missing file is the normal "all defaults" case. */
function loadUserConfig(): { user: ComposerUserConfig; error: string | null } {
  try {
    return { user: JSON.parse(readFileSync(CONFIG_PATH, 'utf8')), error: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { user: {}, error: null };
    return { user: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

function buildConfig(u: ComposerUserConfig) {
  // Spinner resolution: explicit spinnerFrames win, then the named preset,
  // then the default preset. The preset also supplies the default interval.
  const preset = SPINNERS[isSpinnerStyle(u.spinnerStyle) ? u.spinnerStyle : DEFAULT_CONFIG.SPINNER_STYLE];
  const customFrames =
    Array.isArray(u.spinnerFrames) &&
    u.spinnerFrames.length > 0 &&
    u.spinnerFrames.every((f) => typeof f === 'string' && f.length > 0)
      ? u.spinnerFrames
      : null;

  return {
    BOXED_VIEW: u.boxedView ?? DEFAULT_CONFIG.BOXED_VIEW,
    BOX_PAD_X: u.boxPadX ?? DEFAULT_CONFIG.BOX_PAD_X,
    MENU_GAP: u.menuGap ?? DEFAULT_CONFIG.MENU_GAP,
    EXTRA_MENU_INDENT: u.extraMenuIndent ?? DEFAULT_CONFIG.EXTRA_MENU_INDENT,
    BORDER_COLOR: u.borderColor ?? DEFAULT_CONFIG.BORDER_COLOR,
    PREFIX: u.prefix ?? DEFAULT_CONFIG.PREFIX,
    PREFIX_COLOR: u.prefixColor ?? DEFAULT_CONFIG.PREFIX_COLOR,
    CORNERS: (u.corners === 'square' ? 'square' : 'rounded') as 'rounded' | 'square',
    FOCUS_INDICATOR: u.focusIndicator ?? DEFAULT_CONFIG.FOCUS_INDICATOR,
    FOCUSED_BORDER_COLOR: u.focusedBorderColor ?? DEFAULT_CONFIG.FOCUSED_BORDER_COLOR,
    SPINNER: u.spinner ?? DEFAULT_CONFIG.SPINNER,
    SPINNER_FRAMES: (customFrames ?? preset.frames) as readonly string[],
    SPINNER_INTERVAL_MS: positiveNumber(u.spinnerIntervalMs, preset.intervalMs),
    SPINNER_COLOR: u.spinnerColor ?? DEFAULT_CONFIG.SPINNER_COLOR,
    GLOW: u.glow ?? DEFAULT_CONFIG.GLOW,
    GLOW_STYLE: (u.glowStyle === 'shimmer' ? 'shimmer' : 'pulse') as 'pulse' | 'shimmer',
    GLOW_COLOR: u.glowColor ?? DEFAULT_CONFIG.GLOW_COLOR,
    GLOW_PERIOD_MS: positiveNumber(u.glowPeriodMs, DEFAULT_CONFIG.GLOW_PERIOD_MS),
    RAINBOW_PERIOD_MS: positiveNumber(u.rainbowPeriodMs, DEFAULT_CONFIG.RAINBOW_PERIOD_MS),
  };
}

const initial = loadUserConfig();
let lastError = initial.error;

/** Live config — reloadConfig() mutates this object in place, so modules
 * that read `CONFIG.X` at use time see updates without re-importing. */
export const CONFIG = buildConfig(initial.user);

/** Error from the most recent config load, or null if it loaded cleanly. */
export function configLoadError(): string | null {
  return lastError;
}

/** Re-read composer.json into CONFIG. On error the previous config is
 * kept. Returns the error message, or null on success. */
export function reloadConfig(): string | null {
  const { user, error } = loadUserConfig();
  if (!error) Object.assign(CONFIG, buildConfig(user));
  lastError = error;
  return error;
}
