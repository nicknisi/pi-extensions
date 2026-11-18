import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, loadFrom, spinnerFrames } from './config.js';
import { cacheDirIsPrivate, countDiffLines, parseUsage } from './data.js';
import { randomVerb, VERBS } from './verbs.js';
import { streamedChars } from './index.js';
import { fitRow, type Piece } from './layout.js';

describe('loadFrom', () => {
  it('an empty config is classic', () => {
    const { config, errors, warnings } = loadFrom({});
    expect(config.style).toBe('classic');
    expect(config.slots).toEqual(DEFAULTS.slots);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('style alone is a complete config', () => {
    const { config } = loadFrom({ style: 'toad' });
    expect(config.box.border).toBe('heavy');
    expect(config.slots.above).toEqual(['working', 'tokens']);
  });

  it('user overrides win over the style, slot lists replace', () => {
    const { config } = loadFrom({ style: 'toad', box: { padY: 0 }, slots: { above: ['elapsed'] } });
    expect(config.box.padY).toBe(0);
    expect(config.box.border).toBe('heavy');
    expect(config.slots.above).toEqual(['elapsed']);
    expect(config.slots.footerLeft).toEqual(loadFrom({ style: 'toad' }).config.slots.footerLeft);
  });

  it('pre-1.0 keys are a hard error and are ignored', () => {
    const { config, errors, warnings } = loadFrom({
      boxedView: false,
      glowStyle: 'shimmer',
      spinner: true,
      style: 'keycaps',
    });
    expect(errors[0]).toMatch(/pre-1.0 keys that are now ignored: boxedView, glowStyle, spinner/);
    expect(warnings).toEqual([]);
    expect(errors[0]).toMatch(/Migrating from 0.x/);
    expect(config.style).toBe('keycaps');
  });

  it('unknown keys, slots, items and states warn with a suggestion', () => {
    const { warnings } = loadFrom({
      promt: {},
      slots: { footerLft: [], footerLeft: ['brnch', 'context'] },
      items: { contxt: {} },
      prompt: { states: { workng: {} } },
      box: { border: 'dashed' },
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        'unknown key "promt" (did you mean "prompt"?)',
        'slots: unknown slot "footerLft" (did you mean "footerLeft"?)',
        'slots.footerLeft: unknown item "brnch" (did you mean "branch"?)',
        'items: unknown item "contxt" (did you mean "context"?)',
        'prompt.states: unknown state "workng" (did you mean "working"?)',
      ]),
    );
    expect(warnings.some((w) => w.startsWith('box.border: expected one of rounded'))).toBe(true);
  });

  it('a bad value falls back to the style value', () => {
    const { config, warnings } = loadFrom({ box: { padX: -1 }, style: 'nope' });
    expect(config.box.padX).toBe(1);
    expect(config.style).toBe('classic');
    expect(warnings).toHaveLength(2);
  });

  it('spinner frames take a preset name or a list', () => {
    expect(spinnerFrames(loadFrom({ spinner: { frames: 'line' } }).config)).toEqual({
      frames: ['-', '\\', '|', '/'],
      intervalMs: 100,
    });
    expect(spinnerFrames(loadFrom({ spinner: { frames: ['a', 'b'], intervalMs: 50 } }).config)).toEqual({
      frames: ['a', 'b'],
      intervalMs: 50,
    });
  });
});

const piece = (text: string, priority: number, extra: Partial<Piece> = {}): Piece => ({
  forms: [text],
  priority,
  group: priority,
  ...extra,
});

describe('fitRow', () => {
  const o = { separator: ' | ', groupSeparator: ' ' };

  it('the lowest-priority item gives way completely before a higher one shrinks', () => {
    const a = piece('alpha', 90, { forms: ['alpha-long', 'alpha'] });
    const b = piece('bravo', 10, { forms: ['bravo-long', 'bravo'] });
    expect(fitRow([a, b], [], 30, o).left).toBe('alpha-long | bravo-long');
    expect(fitRow([a, b], [], 18, o).left).toBe('alpha-long | bravo');
    expect(fitRow([a, b], [], 15, o).left).toBe('alpha-long');
    expect(fitRow([a, b], [], 7, o).left).toBe('alpha');
  });

  it('a row of only literal text renders nothing', () => {
    expect(fitRow([piece('esc to interrupt', 5, { isText: true })], [], 40, o).width).toBe(0);
  });

  it('elastic items grow into spare width', () => {
    const meter = piece('==', 50, { grow: (extra) => '='.repeat(2 + extra) });
    expect(fitRow([meter], [piece('x', 10)], 10, o)).toMatchObject({ left: '========', right: 'x', width: 9 });
  });

  it('shrinks a truncatable item before dropping it', () => {
    const label = piece('a-very-long-label', 10, { shrink: (w) => 'a-very-long-label'.slice(0, w - 1) + '…' });
    expect(fitRow([label], [], 8, o).left).toBe('a-very-…');
  });
});

describe('countDiffLines', () => {
  it('counts pi edit diff rows', () => {
    const diff = [' 1 alpha', '-2 beta', '-3 gamma', '+2 BETA', '+3 GAMMA', '+4 delta', '   ...', ' 9 omega'].join(
      '\n',
    );
    expect(countDiffLines(diff)).toEqual({ added: 3, removed: 2 });
  });
});

describe('streamedChars', () => {
  it('counts text, thinking and tool arguments without serializing the message', () => {
    expect(streamedChars('abcd')).toBe(4);
    expect(
      streamedChars([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'hello' },
        { type: 'toolCall', arguments: { a: 1 } },
      ]),
    ).toBe(3 + 5 + 7);
    expect(streamedChars(undefined)).toBe(0);
  });
});

describe('field-level validation', () => {
  it('drops badly typed item options and state looks, keeping the rest', () => {
    const { config, warnings } = loadFrom({
      items: { statuses: { hide: 5 }, branch: { priority: 'high', color: 'accent', colour: 'x' } },
      prompt: { states: { typing: { symbol: 5, color: 'accent' }, idle: 'red' } },
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        'items.statuses.hide: expected a list of strings, got 5',
        'items.branch.priority: expected a number, got "high"',
        'unknown key "items.branch.colour" (did you mean "color"?)',
        'prompt.states.typing.symbol: expected a string, got 5',
        'prompt.states.idle: expected an object',
      ]),
    );
    expect(config.items.branch).toEqual({ color: 'accent' });
    expect(config.prompt.states.typing).toEqual({ color: 'accent' });
  });

  it('rejects zero periods and fractional cell counts', () => {
    const { config, warnings } = loadFrom({
      box: { effectPeriodMs: 0, padX: 1.5 },
      working: { bandWidth: 0 },
      spinner: { intervalMs: 0 },
    });
    expect(config.box.effectPeriodMs).toBe(2000);
    expect(config.box.padX).toBe(1);
    expect(config.working.bandWidth).toBe(6);
    expect(config.spinner.intervalMs).toBe(0); // 0 is the documented "preset speed"
    expect(warnings).toHaveLength(3);
  });
});

describe('parseUsage', () => {
  const w = { utilization: 38, resets_at: '2099-01-01T00:00:00Z' };
  it('needs both windows with a numeric utilization', () => {
    expect(parseUsage({ five_hour: w, seven_day: w })).toBeDefined();
    expect(parseUsage({ five_hour: w })).toBeUndefined();
    expect(parseUsage({ five_hour: w, seven_day: { utilization: 'x', resets_at: '' } })).toBeUndefined();
    expect(parseUsage(null)).toBeUndefined();
  });
});

describe('randomVerb', () => {
  it('never returns a blank verb', () => {
    expect(VERBS.every((v) => v.trim() !== '')).toBe(true);
    expect(randomVerb(['', '  '])).toBe('Working');
  });
});

describe('prototype keys', () => {
  it('warn as unknown instead of reading Object.prototype', () => {
    const run = () =>
      loadFrom({
        constructor: 1,
        box: { toString: 'x' },
        items: { branch: { constructor: 'x', toString: 1 } },
        prompt: { states: { typing: { constructor: 'x' } } },
        spinner: { frames: 'constructor' },
        style: 'toString',
      });
    expect(run).not.toThrow();
    const { config, warnings } = run();
    expect(warnings.some((w) => w.includes('items.branch.constructor'))).toBe(true);
    expect(config.style).toBe('classic');
    expect(config.items.branch).toEqual({});
  });
});

describe('cacheDirIsPrivate', () => {
  it('accepts a 0700 dir and rejects symlinks, missing dirs and group/world-writable dirs', () => {
    const base = mkdtempSync(join(tmpdir(), 'composer-cache-'));
    try {
      const ok = join(base, 'ok');
      mkdirSync(ok, { mode: 0o700 });
      expect(cacheDirIsPrivate(ok)).toBe(true);
      const link = join(base, 'link');
      symlinkSync(ok, link);
      expect(cacheDirIsPrivate(link)).toBe(false);
      const open = join(base, 'open');
      mkdirSync(open);
      chmodSync(open, 0o777);
      expect(cacheDirIsPrivate(open)).toBe(false);
      expect(cacheDirIsPrivate(join(base, 'missing'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
