import { describe, expect, it } from 'vitest';
import { parseLabelData, splitFormat, truncateCells } from './utils.js';

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
