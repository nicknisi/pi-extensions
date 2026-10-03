import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { card } from './card.js';

const spec = {
  title: '⚑ Heads up',
  right: 'alt+h to open',
  sections: [['Checkout now retries failed payments.'], ['1 learn more']],
  bottom: 'learn more · dismiss',
};

describe('card', () => {
  it('sets labels into the borders and splits sections with a rule', () => {
    expect(card(60, (s) => s, spec)).toEqual([
      `╭─ ⚑ Heads up ${'─'.repeat(29)} alt+h to open ─╮`,
      `│ Checkout now retries failed payments.${' '.repeat(19)} │`,
      `├${'─'.repeat(58)}┤`,
      `│ 1 learn more${' '.repeat(44)} │`,
      `╰─ learn more · dismiss ${'─'.repeat(35)}╯`,
    ]);
  });

  it('fills the width exactly at every size', () => {
    for (const width of [12, 20, 33, 80, 140]) {
      for (const line of card(width, (s) => s, spec)) expect(visibleWidth(line)).toBe(width);
    }
  });

  it('drops border labels that do not fit', () => {
    const [top, , , , bottom] = card(24, (s) => s, spec);
    expect(top).toBe(`╭─ ⚑ Heads up ${'─'.repeat(8)}─╮`);
    expect(bottom).toBe(`╰${'─'.repeat(22)}╯`);
  });

  it('colors only the border', () => {
    const paint = (s: string) => `\x1b[33m${s}\x1b[39m`;
    const [top] = card(30, paint, { title: 'T', sections: [] });
    expect(top).toBe(`${paint('╭─ ')}T ${paint('─'.repeat(23))}${paint('─╮')}`);
  });
});
