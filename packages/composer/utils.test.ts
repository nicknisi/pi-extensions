import { describe, expect, it } from 'vitest';
import { paneHasFocusedClient, parseFocusInput, parseLabelData, splitFormat, truncateCells } from './utils.js';

describe('parseLabelData', () => {
  it('returns the text when it is a non-empty string', () => {
    expect(parseLabelData({ text: 'fix the tests' })).toBe('fix the tests');
  });

  it('clears on absent, empty, blank, or wrongly-typed text', () => {
    expect(parseLabelData({})).toBeUndefined();
    expect(parseLabelData({ text: '' })).toBeUndefined();
    expect(parseLabelData({ text: '   ' })).toBeUndefined();
    expect(parseLabelData({ text: 42 })).toBeUndefined();
    expect(parseLabelData(null)).toBeUndefined();
    expect(parseLabelData('just a string')).toBeUndefined();
    expect(parseLabelData(undefined)).toBeUndefined();
  });
});

describe('paneHasFocusedClient', () => {
  it('matches only panes selected by a focused tmux client', () => {
    const clients = 'attached,UTF-8\t%1\nattached,focused,UTF-8\t%2\n';
    expect(paneHasFocusedClient('%2', clients)).toBe(true);
    expect(paneHasFocusedClient('%1', clients)).toBe(false);
    expect(paneHasFocusedClient('%20', clients)).toBe(false);
  });

  it('treats sessions outside tmux as focused', () => {
    expect(paneHasFocusedClient(undefined, '')).toBe(true);
  });
});

describe('parseFocusInput', () => {
  it('reads the latest focus event', () => {
    expect(parseFocusInput('', '\x1b[I')).toEqual({ focused: true, carry: '' });
    expect(parseFocusInput('', '\x1b[I\x1b[O')).toEqual({ focused: false, carry: '' });
  });

  it('reassembles a split focus event', () => {
    const first = parseFocusInput('', '\x1b[');
    expect(first).toEqual({ focused: undefined, carry: '\x1b[' });
    expect(parseFocusInput(first.carry, 'O')).toEqual({ focused: false, carry: '' });
  });
});

describe('splitFormat', () => {
  it('splits the template around {name}', () => {
    expect(splitFormat('─ {name} ─')).toEqual(['─ ', ' ─']);
    expect(splitFormat('[ {name} ]')).toEqual(['[ ', ' ]']);
  });

  it('handles a bare {name} template', () => {
    expect(splitFormat('{name}')).toEqual(['', '']);
  });

  it('degrades to the bare name when {name} is missing', () => {
    expect(splitFormat('no placeholder')).toEqual(['', '']);
  });
});

describe('truncateCells', () => {
  it('returns the string unchanged when it fits the budget', () => {
    expect(truncateCells('refactor auth', 20)).toBe('refactor auth');
    expect(truncateCells('abc', 3)).toBe('abc');
  });

  it('truncates with an ellipsis within the cell budget', () => {
    // budget 5 → 4 chars + …
    expect(truncateCells('refactor auth', 5)).toBe('refa…');
  });

  it('counts wide chars as two cells', () => {
    expect(truncateCells('表表表', 4)).toBe('表…');
    expect(truncateCells('表a表', 4)).toBe('表a…');
  });
});
