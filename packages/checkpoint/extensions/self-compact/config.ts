/**
 * Threshold flag parsing and resolution.
 *
 * Pure, Pi-runtime-free helpers so the numeric contract can be unit-tested in
 * isolation. The extension owns all parsing and validation: Pi only hands us
 * the raw string flag values. Invalid configuration is reported as an explicit
 * actionable error so the caller can fail closed at the execution gate rather
 * than silently guessing a default.
 *
 * Rules:
 *   - A value is `<number>` (whole safe integer), `<number>k`, `<number>m`, or
 *     `<number>%`. No expressions, signs, exponents, infinities, or trailing
 *     junk. Fractions are allowed only when a suffix makes them resolve to a
 *     whole token count (e.g. `1.5k` = 1500); percentages resolve against the
 *     full window with a single documented rounding rule (round half up).
 *   - Zero is allowed only where `allowZero` is set (the buffer).
 *   - For a window `W`: `0 < soft < warning <= hard <= floor(0.9 * W)`, where
 *     `hard = min(warning + buffer, floor(0.9 * W))`. A `warning` beyond the
 *     cap is invalid, never silently lowered; a capped `hard == warning` is
 *     valid and enforces immediately.
 */

/** Documented example that always produces a valid ordering on any window. */
export const THRESHOLD_GUIDANCE =
  'try percentages of the window, e.g. `--compact-soft-at 20% --compact-at 50% --compact-buffer 10%`';

export type ThresholdUnit = 'tokens' | 'percent';

export interface ParsedThreshold {
  unit: ThresholdUnit;
  /** Token count when `unit === 'tokens'`, percentage points when `'percent'`. */
  value: number;
}

export type ParseResult = { ok: true; parsed: ParsedThreshold } | { ok: false; error: string };

const THRESHOLD_PATTERN = /^(\d+(?:\.\d+)?)(k|m|%)?$/i;

/** Parse a single threshold flag value without resolving it against a window. */
export function parseThreshold(raw: string, options: { allowZero?: boolean } = {}): ParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'must not be blank' };

  const match = THRESHOLD_PATTERN.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: `invalid threshold "${raw}"; use a whole token count or a k/m/% value (e.g. 250k, 0.5m, 50%)`,
    };
  }

  const numberText = match[1] as string;
  const suffix = (match[2] ?? '').toLowerCase();
  const value = Number(numberText);
  if (!Number.isFinite(value)) return { ok: false, error: `invalid threshold "${raw}"` };

  const allowZero = options.allowZero ?? false;
  if (value === 0 && !allowZero) return { ok: false, error: 'must be greater than zero' };

  if (suffix === '%') {
    return { ok: true, parsed: { unit: 'percent', value } };
  }

  if (suffix === '') {
    if (numberText.includes('.')) {
      return { ok: false, error: `token counts must be whole numbers (use k, m, or %): "${raw}"` };
    }
    if (!Number.isSafeInteger(value)) return { ok: false, error: `token count is too large: "${raw}"` };
    return { ok: true, parsed: { unit: 'tokens', value } };
  }

  // k / m suffix: must resolve to a whole, safe token count.
  const multiplier = suffix === 'k' ? 1_000 : 1_000_000;
  const tokens = value * multiplier;
  if (!Number.isInteger(tokens)) {
    return { ok: false, error: `"${raw}" does not resolve to a whole token count` };
  }
  if (!Number.isSafeInteger(tokens)) return { ok: false, error: `token count is too large: "${raw}"` };
  return { ok: true, parsed: { unit: 'tokens', value: tokens } };
}

export type ResolveTokensResult = { ok: true; tokens: number } | { ok: false; error: string };

/** Resolve a parsed threshold to a whole token count for a given window. */
export function resolveTokens(parsed: ParsedThreshold, contextWindow: number): ResolveTokensResult {
  if (parsed.unit === 'tokens') {
    if (!Number.isSafeInteger(parsed.value)) return { ok: false, error: 'token count is too large' };
    return { ok: true, tokens: parsed.value };
  }
  // Percentage of the full window, rounded half up to a whole token count.
  const raw = (parsed.value / 100) * contextWindow;
  const tokens = Math.round(raw);
  if (!Number.isFinite(tokens) || !Number.isSafeInteger(tokens)) {
    return { ok: false, error: 'percentage does not resolve to a whole token count' };
  }
  return { ok: true, tokens };
}

export interface FlagInputs {
  /** Raw `--compact-soft-at` value. */
  softAt: string;
  /** Raw `--compact-at` value. */
  at: string;
  /** Raw `--compact-buffer` value. */
  buffer: string;
  /** Raw `--compact-prompt` value, or undefined when the flag was not supplied. */
  compactPrompt?: string | undefined;
}

export interface ResolvedThresholds {
  contextWindow: number;
  softTokens: number;
  warningTokens: number;
  hardTokens: number;
  /** floor(0.9 * contextWindow). */
  cap: number;
}

export type ConfigResult =
  | { ok: true; thresholds: ResolvedThresholds; compactPromptOverride: string | undefined }
  | { ok: false; error: string };

/** Percentage of the window a token count represents, rounded to a whole number. */
export function tokensToPercent(tokens: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.round((tokens / contextWindow) * 100);
}

/**
 * Resolve raw flag inputs against a concrete context window. Returns an
 * actionable error (never throws) when the configuration cannot enforce a valid
 * `0 < soft < warning <= hard <= floor(0.9 * W)` ordering, so the caller can
 * fail closed while keeping info/manual controls available.
 */
export function resolveThresholds(inputs: FlagInputs, contextWindow: number): ConfigResult {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { ok: false, error: `self-compact: unknown or invalid model context window (${contextWindow})` };
  }

  // A supplied summary override must be a real literal; blank is invalid rather
  // than a silent fall-through to the default file.
  let compactPromptOverride: string | undefined;
  if (inputs.compactPrompt !== undefined) {
    if (inputs.compactPrompt.trim().length === 0) {
      return { ok: false, error: 'self-compact: --compact-prompt must not be blank' };
    }
    compactPromptOverride = inputs.compactPrompt;
  }

  const soft = parseThreshold(inputs.softAt);
  if (!soft.ok) return { ok: false, error: `self-compact: --compact-soft-at ${soft.error}` };
  const warning = parseThreshold(inputs.at);
  if (!warning.ok) return { ok: false, error: `self-compact: --compact-at ${warning.error}` };
  const buffer = parseThreshold(inputs.buffer, { allowZero: true });
  if (!buffer.ok) return { ok: false, error: `self-compact: --compact-buffer ${buffer.error}` };

  const softTokens = resolveTokens(soft.parsed, contextWindow);
  if (!softTokens.ok) return { ok: false, error: `self-compact: --compact-soft-at ${softTokens.error}` };
  const warningTokens = resolveTokens(warning.parsed, contextWindow);
  if (!warningTokens.ok) return { ok: false, error: `self-compact: --compact-at ${warningTokens.error}` };
  const bufferTokens = resolveTokens(buffer.parsed, contextWindow);
  if (!bufferTokens.ok) return { ok: false, error: `self-compact: --compact-buffer ${bufferTokens.error}` };

  const cap = Math.floor(0.9 * contextWindow);
  const sum = warningTokens.tokens + bufferTokens.tokens;
  if (!Number.isSafeInteger(sum)) {
    return { ok: false, error: 'self-compact: --compact-at plus --compact-buffer overflows' };
  }
  const hardTokens = Math.min(sum, cap);

  const s = softTokens.tokens;
  const w = warningTokens.tokens;
  const h = hardTokens;
  if (!(s > 0 && s < w && w <= h && h <= cap)) {
    return {
      ok: false,
      error:
        `self-compact: thresholds do not fit a ${contextWindow}-token window ` +
        `(soft=${s}, warning=${w}, hard=${h}, max=${cap}); require 0 < soft < warning <= hard <= ${cap}. ` +
        THRESHOLD_GUIDANCE,
    };
  }

  return {
    ok: true,
    thresholds: { contextWindow, softTokens: s, warningTokens: w, hardTokens: h, cap },
    compactPromptOverride,
  };
}

export const FLAG_SOFT_AT = 'compact-soft-at';
export const FLAG_AT = 'compact-at';
export const FLAG_BUFFER = 'compact-buffer';
export const FLAG_PROMPT = 'compact-prompt';

export const DEFAULT_SOFT_AT = '225k';
export const DEFAULT_AT = '250k';
export const DEFAULT_BUFFER = '20k';
