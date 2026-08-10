import { describe, expect, it } from 'vitest';
import { splitFormat, truncateCells } from './utils.js';

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
