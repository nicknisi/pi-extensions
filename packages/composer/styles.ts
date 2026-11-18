/**
 * Built-in styles. A style is only a preset of config values, the same shape
 * as composer.json, so anything a style does you can do (or undo) in your
 * own config.
 */

import type { ComposerConfig } from './config.js';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type StylePreset = DeepPartial<Omit<ComposerConfig, 'style'>>;

/** Shared by styles that want an empty footer and border. */
const NO_SLOTS = {
  above: [],
  topLeft: [],
  topRight: [],
  bottomLeft: [],
  bottomRight: [],
  rightPrompt: [],
  footerLeft: [],
  footerRight: [],
  panel: [],
  panelTop: [],
  panelBottom: [],
};

export const STYLES = {
  /** Composer 0.x + statusline: rounded box, label on the border, one footer row. */
  classic: {},

  /** After Toad: tall padded box, rainbow throbber, live tokens, breadcrumb chips. */
  toad: {
    prompt: { symbol: '', whenBusy: 'symbol' },
    spinner: { frames: ['π'], color: 'accent' },
    box: {
      border: 'heavy',
      color: 'accent',
      padX: 1,
      padY: 1,
      placeholder: 'Ask pi anything · / commands · @ files',
      busyEffect: 'rainbow',
      effectPeriodMs: 1600,
      states: { nearFull: { color: 'context' }, prompt: { color: 'warning' } },
    },
    slots: {
      ...NO_SLOTS,
      above: ['working', 'tokens'],
      bottomRight: ['paste'],
      footerLeft: [['model', 'thinking'], ['branch', 'pr'], ['context', 'cost'], 'statuses', 'scroll'],
    },
    items: {
      model: { icon: '◆', color: 'syntaxKeyword' },
      thinking: { color: 'syntaxKeyword' },
      branch: { icon: '⎇', color: 'success' },
      pr: { color: 'success' },
      context: { icon: '▮', show: 'percent', label: 'ctx', color: 'accent' },
      cost: { color: 'accent' },
      tokens: { color: 'text' },
    },
    icons: 'unicode',
    separator: '   ',
    groupSeparator: ' ‹ ',
  },

  /** After the Codex composer: shaded slab, keys for the current state, context pinned right. */
  keycaps: {
    prompt: { symbol: '›', color: 'text', whenBusy: 'symbol' },
    spinner: { frames: 'dots', color: 'accent' },
    box: { border: 'slab', padX: 1, padY: 0, focusColor: null, busyEffect: 'off' },
    slots: {
      ...NO_SLOTS,
      above: ['working', 'elapsed', 'text:esc to interrupt'],
      footerLeft: ['statuses', 'hints'],
      footerRight: [['model', 'thinking'], 'context'],
    },
    items: {
      context: { show: 'percent', label: 'context left', priority: 100 },
      model: { color: 'muted' },
      hints: { priority: 75 },
      statuses: { priority: 15 },
    },
    icons: 'unicode',
    separator: ' · ',
    toasts: true,
  },

  /** After Starship/Powerlevel10k: an info line above, a right prompt, no footer. */
  starship: {
    prompt: {
      symbol: '❯',
      color: 'success',
      whenBusy: 'spinner',
      states: { typing: { color: 'accent' }, nearFull: { color: 'error' } },
    },
    spinner: { frames: 'dots', color: 'warning' },
    box: { border: 'none', padX: 0, focusColor: null, busyEffect: 'off' },
    slots: {
      ...NO_SLOTS,
      above: ['cwd', ['branch', 'pr'], ['model', 'thinking'], 'statuses', 'working', 'elapsed'],
      rightPrompt: ['paste', 'scroll', 'context', 'cost'],
    },
    items: {
      cwd: { color: 'accent', priority: 95 },
      statuses: { priority: 30 },
      branch: { prefix: 'on ', icon: '⎇', color: 'thinkingMax' },
      pr: { color: 'thinkingMax' },
      model: { prefix: 'via ', icon: '◆', color: 'success' },
      thinking: { color: 'success' },
      working: { color: 'warning' },
      elapsed: { prefix: 'took ', color: 'warning' },
      context: { show: 'percent', label: '' },
    },
    icons: 'unicode',
    separator: ' ',
  },

  /** After btop: titled box, meters in a panel beside the composer on wide panes. */
  sidepanel: {
    box: { border: 'rounded', states: { nearFull: { color: 'context' } } },
    slots: {
      ...NO_SLOTS,
      topLeft: ['working', 'label'],
      topRight: ['statuses'],
      bottomLeft: ['branch'],
      panel: ['context', 'usage', 'tps', 'cost', 'lines', 'tokens', 'scroll'],
      panelTop: [['model', 'thinking']],
      panelBottom: ['pr'],
    },
    items: {
      context: { show: 'bar', barWidth: 14, label: '' },
      scroll: { priority: 99 },
    },
    icons: 'unicode',
    separator: '  ',
  },
} satisfies Record<string, StylePreset>;

export type StyleName = keyof typeof STYLES;
