import { describe, expect, it } from 'vitest';
import {
  parseThreshold,
  resolveThresholds,
  resolveTokens,
  tokensToPercent,
  type FlagInputs,
} from './extensions/self-compact/config.js';

describe('parseThreshold', () => {
  const cases: Array<{ raw: string; allowZero?: boolean; ok: boolean; unit?: string; value?: number }> = [
    { raw: '250000', ok: true, unit: 'tokens', value: 250000 },
    { raw: '250k', ok: true, unit: 'tokens', value: 250000 },
    { raw: '0.5m', ok: true, unit: 'tokens', value: 500000 },
    { raw: '1.5k', ok: true, unit: 'tokens', value: 1500 },
    { raw: '50%', ok: true, unit: 'percent', value: 50 },
    { raw: '22.5%', ok: true, unit: 'percent', value: 22.5 },
    { raw: '  60% ', ok: true, unit: 'percent', value: 60 },
    { raw: '0', allowZero: true, ok: true, unit: 'tokens', value: 0 },
    // Rejections
    { raw: '', ok: false },
    { raw: '   ', ok: false },
    { raw: '0', ok: false }, // zero not allowed by default
    { raw: '-5', ok: false },
    { raw: '1.2345k', ok: false }, // does not resolve to a whole token count
    { raw: '250.5', ok: false }, // unsuffixed must be whole
    { raw: '1e6', ok: false }, // no exponents
    { raw: 'Infinity', ok: false },
    { raw: '250k extra', ok: false }, // trailing junk
    { raw: '250kb', ok: false },
    { raw: '2+2', ok: false },
    { raw: '99999999999999999999', ok: false }, // unsafe integer
  ];

  for (const c of cases) {
    it(`${c.ok ? 'accepts' : 'rejects'} "${c.raw}"${c.allowZero ? ' (allowZero)' : ''}`, () => {
      const result = parseThreshold(c.raw, c.allowZero ? { allowZero: true } : {});
      expect(result.ok).toBe(c.ok);
      if (result.ok && c.ok) {
        expect(result.parsed.unit).toBe(c.unit);
        expect(result.parsed.value).toBe(c.value);
      }
    });
  }
});

describe('resolveTokens', () => {
  it('rounds percentages half up against arbitrary windows', () => {
    // 22.5% of 200000 = 45000 exactly
    expect(resolveTokens({ unit: 'percent', value: 22.5 }, 200000)).toEqual({ ok: true, tokens: 45000 });
    // 33% of 123457 = 40740.81 -> 40741
    expect(resolveTokens({ unit: 'percent', value: 33 }, 123457)).toEqual({ ok: true, tokens: 40741 });
  });

  it('returns fixed token counts unchanged', () => {
    expect(resolveTokens({ unit: 'tokens', value: 250000 }, 1_000_000)).toEqual({ ok: true, tokens: 250000 });
  });
});

describe('tokensToPercent', () => {
  it('rounds to whole percentage points', () => {
    expect(tokensToPercent(250000, 1_000_000)).toBe(25);
    expect(tokensToPercent(270000, 1_000_000)).toBe(27);
    expect(tokensToPercent(0, 200000)).toBe(0);
  });
});

describe('resolveThresholds', () => {
  const defaults = (overrides: Partial<FlagInputs> = {}): FlagInputs => ({
    softAt: '225k',
    at: '250k',
    buffer: '20k',
    ...overrides,
  });

  it('applies 225k/250k/20k defaults on a 1M window (soft/warning/hard 225k/250k/270k)', () => {
    const result = resolveThresholds(defaults(), 1_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.thresholds.softTokens).toBe(225000);
    expect(result.thresholds.warningTokens).toBe(250000);
    expect(result.thresholds.hardTokens).toBe(270000);
    expect(result.compactPromptOverride).toBeUndefined();
  });

  it('resolves explicit 100k/200k/50k (markers 10/20/25% on 1M)', () => {
    const result = resolveThresholds(defaults({ softAt: '100k', at: '200k', buffer: '50k' }), 1_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.thresholds.softTokens).toBe(100000);
    expect(result.thresholds.warningTokens).toBe(200000);
    expect(result.thresholds.hardTokens).toBe(250000);
    expect(tokensToPercent(result.thresholds.softTokens, 1_000_000)).toBe(10);
    expect(tokensToPercent(result.thresholds.warningTokens, 1_000_000)).toBe(20);
    expect(tokensToPercent(result.thresholds.hardTokens, 1_000_000)).toBe(25);
  });

  it('resolves explicit 20%/50%/10% to 20/50/60% of the window', () => {
    const result = resolveThresholds(defaults({ softAt: '20%', at: '50%', buffer: '10%' }), 200000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.thresholds.softTokens).toBe(40000);
    expect(result.thresholds.warningTokens).toBe(100000);
    expect(result.thresholds.hardTokens).toBe(120000);
  });

  it('allows a zero buffer so hard equals warning and enforces there', () => {
    const result = resolveThresholds(defaults({ softAt: '20%', at: '50%', buffer: '0' }), 200000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.thresholds.hardTokens).toBe(result.thresholds.warningTokens);
    expect(result.thresholds.hardTokens).toBe(100000);
  });

  it('caps hard at floor(0.9 * W), even when warning + buffer exceeds it', () => {
    // 50% + 60% = 110% -> capped at 90% of the window.
    const result = resolveThresholds(defaults({ softAt: '20%', at: '50%', buffer: '60%' }), 200000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.thresholds.hardTokens).toBe(180000);
    expect(result.thresholds.cap).toBe(180000);
  });

  it('rejects a warning beyond the 90% cap rather than lowering it', () => {
    const result = resolveThresholds(defaults({ softAt: '20%', at: '95%', buffer: '0' }), 200000);
    expect(result.ok).toBe(false);
  });

  it('rejects equal soft and warning (requires strict soft < warning)', () => {
    const result = resolveThresholds(defaults({ softAt: '50%', at: '50%', buffer: '10%' }), 200000);
    expect(result.ok).toBe(false);
  });

  it('rejects the 225k/250k/20k defaults on a 200k model with actionable guidance', () => {
    const result = resolveThresholds(defaults(), 200000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.error).toContain('--compact-soft-at 20%');
    expect(result.error).toContain('200000');
  });

  it('accepts percentage flags that fix a small model', () => {
    const result = resolveThresholds(defaults({ softAt: '20%', at: '50%', buffer: '10%' }), 200000);
    expect(result.ok).toBe(true);
  });

  it('rejects a blank threshold rather than defaulting', () => {
    expect(resolveThresholds(defaults({ softAt: '' }), 1_000_000).ok).toBe(false);
    expect(resolveThresholds(defaults({ at: '   ' }), 1_000_000).ok).toBe(false);
  });

  it('rejects an unknown or invalid context window', () => {
    expect(resolveThresholds(defaults(), 0).ok).toBe(false);
    expect(resolveThresholds(defaults(), Number.NaN).ok).toBe(false);
  });

  it('carries a nonblank literal --compact-prompt through as an override', () => {
    const result = resolveThresholds(defaults({ compactPrompt: 'CUSTOM SUMMARY PROMPT' }), 1_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.compactPromptOverride).toBe('CUSTOM SUMMARY PROMPT');
  });

  it('rejects a blank --compact-prompt rather than silently using the default', () => {
    const result = resolveThresholds(defaults({ compactPrompt: '   ' }), 1_000_000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid');
    expect(result.error).toContain('--compact-prompt');
  });
});
