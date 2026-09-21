/**
 * Pure 20-cell context bar renderer plus the latest-applicable cached-token
 * calculation. Pi-runtime-free so the exact rendering is unit-testable.
 *
 * The bar shows 20 cells inside brackets, each cell 5% of the full window:
 *   - `#` cached (prompt-cache) tokens
 *   - `=` remaining used tokens
 *   - `-` free
 * Threshold markers replace whichever cell they land on, with a deterministic
 * collision priority of hard `|` > warning `!` > soft `~`. When usage is
 * unknown (null right after compaction) the fills are blank but the markers
 * and the bracket frame remain, and the label reads `?%` rather than 0%.
 */
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const BAR_CELLS = 20;
const CELL_PERCENT = 100 / BAR_CELLS; // 5

const CELL_FREE = '-';
const CELL_USED = '=';
const CELL_CACHED = '#';
const MARKER_SOFT = '~';
const MARKER_WARNING = '!';
const MARKER_HARD = '|';

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Filled-cell count for a percentage: floor, clamped to 0..BAR_CELLS. */
function filledCells(percent: number): number {
  return clamp(Math.floor(percent / CELL_PERCENT), 0, BAR_CELLS);
}

/** Marker cell index for a percentage: ceil(percent/5) - 1, clamped 0..19. */
function markerCell(percent: number): number {
  return clamp(Math.ceil(percent / CELL_PERCENT) - 1, 0, BAR_CELLS - 1);
}

export interface BarMarkers {
  /** Soft threshold as a percentage of the window. */
  softPercent: number;
  /** Warning threshold as a percentage of the window. */
  warningPercent: number;
  /** Hard threshold as a percentage of the window. */
  hardPercent: number;
}

export interface BarInput extends BarMarkers {
  /** Used context as a percentage of the window, or null when unknown. */
  usedPercent: number | null;
  /** Cached context as a percentage of the window, or null when unknown. */
  cachedPercent: number | null;
}

/** Render the 20-cell bar body (without brackets or label). */
export function renderBarCells(input: BarInput): string {
  const cells: string[] = Array.from({ length: BAR_CELLS }, () => CELL_FREE);

  if (input.usedPercent !== null) {
    const used = filledCells(input.usedPercent);
    // Cached is bounded by used: it can never exceed measured usage.
    const cached = input.cachedPercent === null ? 0 : Math.min(filledCells(input.cachedPercent), used);
    for (let i = 0; i < used; i++) {
      cells[i] = i < cached ? CELL_CACHED : CELL_USED;
    }
  }

  // Place lowest priority first so higher priority overwrites on collision:
  // soft, then warning, then hard.
  cells[markerCell(input.softPercent)] = MARKER_SOFT;
  cells[markerCell(input.warningPercent)] = MARKER_WARNING;
  cells[markerCell(input.hardPercent)] = MARKER_HARD;

  return cells.join('');
}

/** Render the full widget line: `[cells] 40%` (or `?%` when usage is unknown). */
export function renderBarLine(input: BarInput): string {
  const cells = renderBarCells(input);
  const label = input.usedPercent === null ? '?%' : `${Math.round(input.usedPercent)}%`;
  return `[${cells}] ${label}`;
}

export interface ContextBarThresholds {
  softTokens: number;
  warningTokens: number;
  hardTokens: number;
  contextWindow: number;
}

export interface ContextBarUsage {
  tokens: number | null;
  cachedTokens: number | null;
}

/** Build the widget line from token counts against a resolved threshold set. */
export function contextBarLine(usage: ContextBarUsage, thresholds: ContextBarThresholds): string {
  const w = thresholds.contextWindow;
  const toPercent = (tokens: number | null): number | null => (tokens === null || w <= 0 ? null : (tokens / w) * 100);
  return renderBarLine({
    usedPercent: toPercent(usage.tokens),
    cachedPercent: toPercent(usage.cachedTokens),
    softPercent: w > 0 ? (thresholds.softTokens / w) * 100 : 0,
    warningPercent: w > 0 ? (thresholds.warningTokens / w) * 100 : 0,
    hardPercent: w > 0 ? (thresholds.hardTokens / w) * 100 : 0,
  });
}

function isAssistantMessageEntry(
  entry: SessionEntry,
): entry is SessionEntry & { type: 'message'; message: AssistantMessage } {
  return entry.type === 'message' && (entry as { message?: { role?: unknown } }).message?.role === 'assistant';
}

/**
 * The cacheRead value that describes the *current* prompt: the most recent
 * assistant usage on the branch, unless a compaction is more recent (in which
 * case pre-compaction caches no longer describe the new prompt, so return
 * null). Never sums cacheRead across the session.
 */
export function latestApplicableCacheRead(entries: SessionEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    // A compaction boundary invalidates any earlier cached measurement.
    if (entry.type === 'compaction') return null;
    if (isAssistantMessageEntry(entry)) {
      const cacheRead = entry.message.usage?.cacheRead;
      return typeof cacheRead === 'number' && Number.isFinite(cacheRead) && cacheRead >= 0 ? cacheRead : null;
    }
  }
  return null;
}
