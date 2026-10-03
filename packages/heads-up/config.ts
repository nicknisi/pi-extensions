import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface HeadsUpConfig {
  /** A turn with at least this many tool calls counts as long. */
  minTools: number;
  /** A turn running at least this long counts as long. */
  minSeconds: number;
  /** Minimum gap between two checks. */
  cooldownSeconds: number;
  /** Side-agent model as provider/model-id. Defaults to the session model. */
  model?: string;
  /** Shortcut that opens the note's action panel. */
  shortcut: string;
  /** Transcript digest budget in characters (most recent kept). */
  maxDigestChars: number;
}

export const DEFAULT_CONFIG: HeadsUpConfig = {
  minTools: 8,
  minSeconds: 120,
  cooldownSeconds: 300,
  shortcut: 'alt+h',
  maxDigestChars: 120_000,
};

export const configPath = (agentDir = getAgentDir()): string => join(agentDir, 'configs', 'heads-up.json');

export const storePath = (agentDir = getAgentDir()): string => join(agentDir, 'heads-up', 'store.json');

export function parseModelSpec(value: string): { provider: string; id: string } | undefined {
  const spec = value.trim();
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

export function loadConfig(agentDir = getAgentDir()): { config: HeadsUpConfig; warnings: string[] } {
  const path = configPath(agentDir);
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG },
      warnings: [`heads-up: invalid config at ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const warnings: string[] = [];
  const config: HeadsUpConfig = {
    minTools: positive(o.minTools, DEFAULT_CONFIG.minTools),
    minSeconds: positive(o.minSeconds, DEFAULT_CONFIG.minSeconds),
    cooldownSeconds: positive(o.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds),
    shortcut: typeof o.shortcut === 'string' && o.shortcut.trim() ? o.shortcut.trim() : DEFAULT_CONFIG.shortcut,
    maxDigestChars: positive(o.maxDigestChars, DEFAULT_CONFIG.maxDigestChars),
  };
  if (o.model !== undefined) {
    if (typeof o.model === 'string' && parseModelSpec(o.model)) config.model = o.model.trim();
    else warnings.push(`heads-up: config model must be a provider/model-id string; using the session model`);
  }
  return { config, warnings };
}

// ── Store: cross-session state, local only ───────────────────────────────

export type Kind = 'proposed' | 'explained' | 'page' | 'chat' | 'known' | 'dismissed' | 'ignored_submit';

export type HeadsUpEvent = { ts: number; kind: Kind; learn: string };

export interface Store {
  /** Topics marked understood; the check prompt excludes them. */
  known: string[];
  /** Recent suggestions, so the next check skips them. */
  offered: string[];
  /** Set by `/heads-up off`. */
  disabled: boolean;
  /** Feedback log for tuning the bar. */
  events: HeadsUpEvent[];
}

export const MAX_KNOWN = 50;
export const MAX_OFFERED = 5;
export const MAX_EVENTS = 500;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export function readStore(agentDir = getAgentDir()): Store {
  let raw: unknown;
  try {
    raw = readJson(storePath(agentDir));
  } catch {
    raw = undefined;
  }
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    known: strings(o.known),
    offered: strings(o.offered),
    disabled: o.disabled === true,
    events: Array.isArray(o.events) ? (o.events as HeadsUpEvent[]) : [],
  };
}

/** Read-modify-write the store file (re-read each time: other pi sessions share it). */
export function updateStore(change: (store: Store) => void, agentDir = getAgentDir()): Store {
  const store = readStore(agentDir);
  change(store);
  const path = storePath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
  return store;
}

export const pushFront = (list: string[], item: string, max: number): string[] =>
  [item, ...list.filter((i) => i !== item)].slice(0, max);

export const logEvent = (kind: Kind, learn: string): void => {
  updateStore((s) => {
    s.events = [...s.events, { ts: Date.now(), kind, learn }].slice(-MAX_EVENTS);
  });
};
