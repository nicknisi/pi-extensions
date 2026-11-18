import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/** Model-facing text overrides (vendored from @juicesharp/rpiv-config). */
export interface GuidanceFields {
  promptSnippet?: string;
  promptGuidelines?: string[];
  description?: string;
}

/** Keep only the non-empty guidance fields (vendored from @juicesharp/rpiv-config). */
export function validateGuidanceFields(fields: unknown): GuidanceFields {
  if (!fields || typeof fields !== 'object') return {};
  const g = fields as Record<string, unknown>;
  const result: GuidanceFields = {};
  if (typeof g.promptSnippet === 'string' && g.promptSnippet.length > 0) result.promptSnippet = g.promptSnippet;
  if (
    Array.isArray(g.promptGuidelines) &&
    g.promptGuidelines.length > 0 &&
    g.promptGuidelines.every((s) => typeof s === 'string' && s.length > 0)
  ) {
    result.promptGuidelines = g.promptGuidelines;
  }
  if (typeof g.description === 'string' && g.description.length > 0) result.description = g.description;
  return result;
}

/** `~/.pi/agent/configs/ask-user-question.json`, honoring PI_CODING_AGENT_DIR. */
export function configFilePath(): string {
  return join(getAgentDir(), 'configs', 'ask-user-question.json');
}

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = 'ctrl+]';
export const COLLAPSE_KEY_OFF: CollapseKeySpec = 'off';
export const DEFAULT_NOTES_KEY = 'n';

export interface AskUserQuestionConfig {
  guidance?: GuidanceFields;
  /**
   * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
   * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
   * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
   * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
   * Pass `"off"` to disable the collapse shortcut entirely.
   */
  collapseKey?: CollapseKeySpec | undefined;
  /**
   * Key that opens the notes editor. Defaults to `"n"`. A single character of any
   * script (e.g. `"т"` on a Cyrillic layout) matches as typed; anything else is a
   * key spec in the `collapseKey` format, e.g. `"ctrl+n"`.
   */
  notesKey?: string | undefined;
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
  'escape',
  'esc',
  'enter',
  'return',
  'tab',
  'space',
  'backspace',
  'delete',
  'insert',
  'clear',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'super']);

function isValidCollapseKeySpec(spec: string): boolean {
  // Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then a
  // base key that is a single printable character or a named special key. A loose
  // check is not enough — pi-tui's `parseKeyId` takes the LAST `+`-part as the key
  // and ignores unknown parts, so a typo like `ctr+]` would silently match every
  // bare `]` keypress (and the raw terminal listener would consume them globally).
  if (!spec) return false;
  if (spec.startsWith('+') || spec.endsWith('+') || spec.includes('++')) return false;
  const parts = spec.split('+');
  const base = parts[parts.length - 1] ?? '';
  const modifiers = parts.slice(0, -1);
  if (modifiers.length !== new Set(modifiers).size) return false;
  if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
  return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, 'collapseKey'>): CollapseKeySpec {
  // Fork: a non-string value (e.g. `123`) falls back to the default instead of throwing.
  const raw = typeof config.collapseKey === 'string' ? config.collapseKey.trim().toLowerCase() : undefined;
  if (raw === undefined || raw === '') return DEFAULT_COLLAPSE_KEY;
  if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
  return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

// Keys the questionnaire already navigates with — a notes key on one of them would shadow it.
const NOTES_KEY_RESERVED = new Set(['space', 'enter', 'return', 'tab', 'escape', 'esc', 'up', 'down', 'left', 'right']);

export function resolveNotesKey(config: Pick<AskUserQuestionConfig, 'notesKey'>): string {
  const raw = typeof config.notesKey === 'string' ? config.notesKey.trim() : undefined;
  if (!raw) return DEFAULT_NOTES_KEY;
  if ([...raw].length === 1) return raw;
  const spec = raw.toLowerCase();
  return isValidCollapseKeySpec(spec) && !NOTES_KEY_RESERVED.has(spec) ? spec : DEFAULT_NOTES_KEY;
}

/** A single-character notes key shows as configured (`n`, not `N`); a spec is display-cased. */
export function formatNotesKeyForDisplay(notesKey: string): string {
  return [...notesKey].length === 1 ? notesKey : formatKeySpecForDisplay(notesKey);
}

// The only compound-word names in SPECIAL_KEYS — first-letter capitalization
// alone would render them "Pageup"/"Pagedown".
const COMPOUND_KEY_DISPLAY: Record<string, string> = {
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

/**
 * Pretty-print a resolved key spec for UI copy: each `+`-part gets its first
 * character uppercased (`"ctrl+]"` → `"Ctrl+]"`, `"alt+o"` → `"Alt+O"`,
 * `"f9"` → `"F9"`, `"ctrl+pagedown"` → `"Ctrl+PageDown"`). Display-only — key
 * matching always uses the raw lowercase spec (`matchesKey` lowercases ids),
 * so never feed the result back into it.
 */
export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
  return spec
    .split('+')
    .map(
      (part) =>
        COMPOUND_KEY_DISPLAY[part] ??
        (part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
    )
    .join('+');
}

/** The config file as a plain object; missing, malformed or non-object JSON reads as `{}`. */
export function loadConfig(): AskUserQuestionConfig {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as AskUserQuestionConfig;
  } catch (err) {
    console.warn(`ask-user-question: invalid JSON at ${path}, using defaults — ${(err as Error).message}`);
    return {};
  }
}
