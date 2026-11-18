/**
 * Built-in styles. A style is only a preset of config values, the same shape
 * as composer.json, so anything a style does you can do (or undo) in your
 * own config.
 *
 * Styles change chrome only: the input frame, the prompt symbol, motion, and
 * where the working line sits. Both show the same status row with the same
 * items and formatting (the defaults in config.ts).
 */

import type { ComposerConfig } from './config.js';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type StylePreset = DeepPartial<Omit<ComposerConfig, 'style'>>;

export const STYLES = {
  /** Rounded box with the session label on its border, working line above, one status row below. */
  box: {},

  /** A shaded slab instead of a box (after the Codex composer), with the same status row. */
  slab: {
    prompt: { symbol: '›', color: 'text', whenBusy: 'symbol' },
    box: { border: 'slab', padX: 1, padY: 0, focusColor: null, busyEffect: 'off' },
    slots: {
      above: ['working', 'elapsed', 'text:esc to interrupt'],
      topRight: [],
    },
    toasts: true,
  },
} satisfies Record<string, StylePreset>;

export type StyleName = keyof typeof STYLES;
