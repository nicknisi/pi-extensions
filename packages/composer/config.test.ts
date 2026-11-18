import { describe, expect, it } from 'vitest';
import { DEFAULTS, loadFrom, spinnerFrames } from './config.js';
import { countDiffLines } from './data.js';
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
    const { config, errors } = loadFrom({ boxedView: false, glowStyle: 'shimmer', style: 'keycaps' });
    expect(errors[0]).toMatch(/pre-1.0 keys that are now ignored: boxedView, glowStyle/);
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
