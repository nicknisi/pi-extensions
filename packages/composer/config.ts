/**
 * composer.json — one file for the whole bottom of the screen.
 *
 * Resolution: built-in defaults ← the chosen style preset ← your overrides.
 * Objects merge key by key; arrays (slot lists, spinner frames) replace.
 * Every key is optional: `{ "style": "toad" }` is a complete config.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { STYLES, type StyleName } from './styles.js';

// ─── Vocabulary ───────────────────────────────────────────────────────────

export const STATES = ['idle', 'typing', 'paste', 'scrolled', 'nearFull', 'working', 'tool', 'prompt'] as const;
export type StateName = (typeof STATES)[number];

export const SLOTS = [
  'above',
  'topLeft',
  'topRight',
  'bottomLeft',
  'bottomRight',
  'rightPrompt',
  'footerLeft',
  'footerRight',
  'panel',
  'panelTop',
  'panelBottom',
] as const;
export type SlotName = (typeof SLOTS)[number];

/** A slot entry: an item name, or a group of item names joined by `groupSeparator`. */
export type SlotEntry = string | string[];

export const ITEMS = [
  'label',
  'model',
  'thinking',
  'cost',
  'lines',
  'usage',
  'context',
  'branch',
  'pr',
  'cwd',
  'statuses',
  'working',
  'elapsed',
  'tokens',
  'tps',
  'hints',
  'mode',
  'paste',
  'scroll',
] as const;
export type ItemName = (typeof ITEMS)[number];

export const BORDERS = ['rounded', 'square', 'heavy', 'rule', 'slab', 'none'] as const;
export type BorderStyle = (typeof BORDERS)[number];
export const EFFECTS = ['off', 'pulse', 'shimmer', 'rainbow'] as const;
export type BusyEffect = (typeof EFFECTS)[number];

/** Built-in spinner presets; `spinner.frames` takes one of these names or a frame array. */
export const SPINNERS: Record<string, { frames: string[]; intervalMs: number }> = {
  dots: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], intervalMs: 80 },
  disc: { frames: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'], intervalMs: 90 },
  moon: { frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'], intervalMs: 90 },
  star: { frames: ['✶', '✸', '✹', '✺', '✹', '✸'], intervalMs: 90 },
  orbit: { frames: ['◜', '◠', '◝', '◞', '◡', '◟'], intervalMs: 80 },
  corners: { frames: ['▖', '▘', '▝', '▗'], intervalMs: 120 },
  triangle: { frames: ['◢', '◣', '◤', '◥'], intervalMs: 120 },
  line: { frames: ['-', '\\', '|', '/'], intervalMs: 100 },
  pulse: { frames: ['·', '•', '●', '•'], intervalMs: 160 },
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
  'mini-scanner': { frames: ['●··', '·●·', '··●', '·●·'], intervalMs: 120 },
};

// ─── Shape ────────────────────────────────────────────────────────────────

export interface StateLook {
  symbol?: string;
  color?: string;
}

export interface ItemOptions {
  /** Higher survives longer when a row is too narrow. */
  priority?: number;
  color?: string;
  /** Glyph before the item; "" hides it. */
  icon?: string;
  /** Plain text before / after the item, e.g. "on " (painted dim). */
  prefix?: string;
  suffix?: string;
  /** context: what to show. */
  show?: 'bar' | 'percent' | 'tokens';
  /** context: widest the elastic bar may grow. */
  barWidth?: number;
  /** context: words after the percentage, e.g. "ctx" or "context left". */
  label?: string;
  /** statuses: extension status keys to leave out. */
  hide?: string[];
  /** usage: only show when the 5h or 7d remaining % is below this. */
  showBelow?: number;
}

export interface ComposerConfig {
  style: StyleName;
  prompt: {
    symbol: string;
    color: string;
    whenBusy: 'spinner' | 'symbol';
    states: Partial<Record<StateName, StateLook>>;
  };
  spinner: { frames: string | string[]; intervalMs: number; color: string };
  box: {
    border: BorderStyle;
    color: string;
    focusColor: string | null;
    background: string;
    padX: number;
    padY: number;
    placeholder: string | null;
    inlay: 'plain' | 'bracket';
    busyEffect: BusyEffect;
    effectColor: string;
    effectPeriodMs: number;
    states: Partial<Record<StateName, { color?: string }>>;
    menuGap: number;
    menuIndent: number;
  };
  working: {
    messages: 'verbs' | 'default' | string[];
    shimmer: boolean;
    shimmerPeriodMs: number;
    bandWidth: number;
    baseColor: string;
    highlightColor: string;
  };
  slots: Record<SlotName, SlotEntry[]>;
  items: Partial<Record<ItemName, ItemOptions>>;
  panel: { width: number; minWidth: number };
  icons: 'nerd' | 'unicode' | 'ascii';
  separator: string;
  groupSeparator: string;
  toasts: boolean;
}

/** The shape every style starts from. Equal to the `classic` look. */
export const DEFAULTS: ComposerConfig = {
  style: 'classic',
  prompt: { symbol: '❯', color: 'accent', whenBusy: 'spinner', states: {} },
  spinner: { frames: 'dots', intervalMs: 0, color: 'accent' },
  box: {
    border: 'rounded',
    color: 'border',
    focusColor: 'accent',
    background: 'userMessageBg',
    padX: 1,
    padY: 0,
    placeholder: null,
    inlay: 'plain',
    busyEffect: 'pulse',
    effectColor: 'accent',
    effectPeriodMs: 2000,
    states: {},
    menuGap: 0,
    menuIndent: 1,
  },
  working: {
    messages: 'verbs',
    shimmer: true,
    shimmerPeriodMs: 2000,
    bandWidth: 6,
    baseColor: 'muted',
    highlightColor: 'text',
  },
  slots: {
    above: ['working'],
    topLeft: [],
    topRight: ['label'],
    bottomLeft: [],
    bottomRight: [],
    rightPrompt: [],
    footerLeft: [['model', 'thinking'], 'cost', 'lines', 'usage', 'statuses', 'context'],
    footerRight: [['branch', 'pr']],
    panel: [],
    panelTop: [],
    panelBottom: [],
  },
  items: {},
  panel: { width: 34, minWidth: 100 },
  icons: 'nerd',
  separator: ' │ ',
  groupSeparator: ' ',
  toasts: false,
};

/** Flat keys from composer < 1.0. Present in a config = hard error. */
const LEGACY_KEYS = [
  'boxedView',
  'boxPadX',
  'menuGap',
  'extraMenuIndent',
  'borderColor',
  'prefix',
  'prefixColor',
  'corners',
  'focusIndicator',
  'focusedBorderColor',
  'sessionName',
  'sessionNameColor',
  'sessionNamePosition',
  'sessionNameFormat',
  'sessionNameMaxWidth',
  'sessionNameBorder',
  'spinnerStyle',
  'spinnerFrames',
  'spinnerIntervalMs',
  'spinnerColor',
  'glow',
  'glowStyle',
  'glowColor',
  'glowPeriodMs',
  'rainbowPeriodMs',
];

// ─── Validation ───────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

function suggest(key: string, known: readonly string[]): string {
  const best = known
    .map((k) => [k, distance(key.toLowerCase(), k.toLowerCase())] as const)
    .sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= Math.max(2, Math.floor(key.length / 3)) ? ` (did you mean "${best[0]}"?)` : '';
}

const ENUMS: Record<string, readonly string[]> = {
  'prompt.whenBusy': ['spinner', 'symbol'],
  'box.border': BORDERS,
  'box.inlay': ['plain', 'bracket'],
  'box.busyEffect': EFFECTS,
  icons: ['nerd', 'unicode', 'ascii'],
};

const isEntry = (v: unknown) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

/**
 * Check `user` against the shape of DEFAULTS. Returns the keys that are safe
 * to merge; everything dropped gets a warning naming the path.
 */
export function validate(user: Json, warnings: string[]): Json {
  const clean: Json = {};
  for (const [key, value] of Object.entries(user)) {
    if (key.startsWith('$')) continue; // $schema, $comment
    if (key === 'style') {
      if (typeof value === 'string' && value in STYLES) clean.style = value;
      else warnings.push(`style: "${String(value)}" is not a style; use one of ${Object.keys(STYLES).join(', ')}`);
      continue;
    }
    if (!(key in DEFAULTS)) {
      if (!LEGACY_KEYS.includes(key)) warnings.push(`unknown key "${key}"${suggest(key, Object.keys(DEFAULTS))}`);
      continue;
    }
    const v = validateValue(key, value, (DEFAULTS as unknown as Json)[key], warnings);
    if (v !== undefined) clean[key] = v;
  }
  return clean;
}

function validateValue(path: string, value: unknown, base: unknown, warnings: string[]): unknown {
  const bad = (want: string) => {
    warnings.push(`${path}: expected ${want}, got ${JSON.stringify(value)}`);
    return undefined;
  };
  if (ENUMS[path]) return ENUMS[path].includes(value as string) ? value : bad(`one of ${ENUMS[path].join(', ')}`);
  if (path === 'slots') {
    if (!isObject(value)) return bad('an object of slot lists');
    const out: Json = {};
    for (const [slot, list] of Object.entries(value)) {
      if (!(SLOTS as readonly string[]).includes(slot)) {
        warnings.push(`slots: unknown slot "${slot}"${suggest(slot, SLOTS)}`);
        continue;
      }
      if (!Array.isArray(list) || !list.every(isEntry)) {
        warnings.push(`slots.${slot}: expected a list of item names`);
        continue;
      }
      const items = list.flat().filter((n) => !isItemRef(n));
      for (const n of items) warnings.push(`slots.${slot}: unknown item "${n}"${suggest(n, ITEMS)}`);
      out[slot] = list
        .map((e) => (Array.isArray(e) ? e.filter(isItemRef) : e))
        .filter((e) => (Array.isArray(e) ? e.length : isItemRef(e)));
    }
    return out;
  }
  if (path === 'items') {
    if (!isObject(value)) return bad('an object keyed by item name');
    const out: Json = {};
    for (const [name, opts] of Object.entries(value)) {
      if (!(ITEMS as readonly string[]).includes(name)) {
        warnings.push(`items: unknown item "${name}"${suggest(name, ITEMS)}`);
        continue;
      }
      if (!isObject(opts)) {
        warnings.push(`items.${name}: expected an object`);
        continue;
      }
      out[name] = opts;
    }
    return out;
  }
  if (path === 'prompt.states' || path === 'box.states') {
    if (!isObject(value)) return bad('an object keyed by state');
    const out: Json = {};
    for (const [state, look] of Object.entries(value)) {
      if (!(STATES as readonly string[]).includes(state))
        warnings.push(`${path}: unknown state "${state}"${suggest(state, STATES)}`);
      else if (isObject(look)) out[state] = look;
    }
    return out;
  }
  if (path === 'spinner.frames')
    return (typeof value === 'string' && value in SPINNERS) ||
      (Array.isArray(value) && value.every((f) => typeof f === 'string'))
      ? value
      : bad(`a preset (${Object.keys(SPINNERS).join(', ')}) or a list of frames`);
  if (path === 'working.messages')
    return value === 'verbs' ||
      value === 'default' ||
      (Array.isArray(value) && value.every((m) => typeof m === 'string'))
      ? value
      : bad('"verbs", "default", or a list of messages');
  if (path === 'box.focusColor' || path === 'box.placeholder')
    return value === null || typeof value === 'string' ? value : bad('a string or null');
  if (isObject(base)) {
    if (!isObject(value)) return bad('an object');
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      if (!(k in base)) {
        warnings.push(`unknown key "${path}.${k}"${suggest(k, Object.keys(base))}`);
        continue;
      }
      const checked = validateValue(`${path}.${k}`, v, base[k], warnings);
      if (checked !== undefined) out[k] = checked;
    }
    return out;
  }
  if (typeof base === 'number') return typeof value === 'number' && value >= 0 ? value : bad('a number ≥ 0');
  if (typeof value !== typeof base) return bad(`a ${typeof base}`);
  return value;
}

/** `text:Anything` is a literal; `status:<key>` is one extension status. */
export function isItemRef(name: string): boolean {
  return (ITEMS as readonly string[]).includes(name) || name.startsWith('text:') || name.startsWith('status:');
}

// ─── Merge ────────────────────────────────────────────────────────────────

function merge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base[k]) && k !== 'slots' ? merge(base[k] as Json, v) : v;
  }
  // Slots replace per slot, not per entry.
  if (isObject(over.slots)) out.slots = { ...(base.slots as Json), ...over.slots };
  return out;
}

/** Defaults ← style preset ← user overrides. */
export function resolveConfig(user: Json, styleOverride?: StyleName): ComposerConfig {
  const style = styleOverride ?? (user.style as StyleName | undefined) ?? 'classic';
  const preset = STYLES[style] as unknown as Json;
  const withStyle = merge(DEFAULTS as unknown as Json, { ...preset, style });
  // A session style preview shows the preset as shipped, without your overrides.
  return (styleOverride ? withStyle : merge(withStyle, user)) as unknown as ComposerConfig;
}

/** Spinner frames + interval after resolving a preset name. */
export function spinnerFrames(cfg: ComposerConfig): { frames: string[]; intervalMs: number } {
  const preset = typeof cfg.spinner.frames === 'string' ? SPINNERS[cfg.spinner.frames] : undefined;
  const frames = preset ? preset.frames : (cfg.spinner.frames as string[]);
  return { frames, intervalMs: cfg.spinner.intervalMs || preset?.intervalMs || 80 };
}

// ─── Loading ──────────────────────────────────────────────────────────────

export const CONFIG_PATH = join(getAgentDir(), 'configs', 'composer.json');

export interface LoadResult {
  config: ComposerConfig;
  /** Fatal-for-the-file problems (bad JSON, pre-1.0 keys). */
  errors: string[];
  warnings: string[];
  user: Json;
}

/** Parse + validate a raw config object. Pure; used by load() and tests. */
export function loadFrom(raw: unknown, styleOverride?: StyleName): LoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw !== undefined && !isObject(raw)) errors.push('composer.json must be a JSON object');
  const obj = isObject(raw) ? { ...raw } : {};
  const legacy = Object.keys(obj).filter((k) => LEGACY_KEYS.includes(k));
  // 0.x had a boolean `spinner`; 1.0's `spinner` is an object.
  if (typeof obj.spinner === 'boolean') {
    legacy.push('spinner');
    delete obj.spinner;
  }
  if (legacy.length)
    errors.push(
      `composer.json uses pre-1.0 keys that are now ignored: ${legacy.join(', ')}. ` +
        'Composer 1.0 has a new nested config; see the README section "Migrating from 0.x".',
    );
  const user = validate(obj, warnings);
  return { config: resolveConfig(user, styleOverride), errors, warnings, user };
}

export function load(styleOverride?: StyleName, path = CONFIG_PATH): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      const result = loadFrom(undefined, styleOverride);
      result.errors.push(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }
  return loadFrom(raw, styleOverride);
}
