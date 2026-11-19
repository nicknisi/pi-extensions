import type { SelectListTheme } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { filterSelectItems, SearchableSelectList } from './searchable-select-list.js';

const theme: SelectListTheme = {
  selectedPrefix: (text) => text,
  selectedText: (text) => text,
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
};

describe('SearchableSelectList.setItems', () => {
  it('refreshes descriptions while preserving the selected value', () => {
    const list = new SearchableSelectList(
      [
        { value: 'first', label: 'First', description: 'old first' },
        { value: 'second', label: 'Second', description: 'old second' },
      ],
      5,
      theme,
    );
    list.selectList.setSelectedIndex(1);

    list.setItems([
      { value: 'first', label: 'First', description: 'new first' },
      { value: 'second', label: 'Second', description: 'new second' },
    ]);

    expect(list.selectList.getSelectedItem()?.value).toBe('second');
    expect(list.render(100).join('\n')).toContain('new second');
    expect(list.render(100).join('\n')).not.toContain('old second');
  });
});

const runs = [
  {
    value: '3f2a-uuid',
    label: '\u001b[32m✓\u001b[39m [subagents] reviewer',
    description: 'claude · review the auth diff',
  },
  { value: 'c0de-uuid', label: '● [subagents] scout', description: 'haiku · map the parser' },
];

describe('filterSelectItems', () => {
  it('matches agent, prompt, and id substrings case-insensitively', () => {
    expect(filterSelectItems(runs, 'Reviewer').map((i) => i.value)).toEqual(['3f2a-uuid']);
    expect(filterSelectItems(runs, 'parser').map((i) => i.value)).toEqual(['c0de-uuid']);
    expect(filterSelectItems(runs, 'c0de').map((i) => i.value)).toEqual(['c0de-uuid']);
    expect(filterSelectItems(runs, '').map((i) => i.value)).toEqual(['3f2a-uuid', 'c0de-uuid']);
  });

  it('requires every term and ignores ANSI styling', () => {
    expect(filterSelectItems(runs, 'scout map').map((i) => i.value)).toEqual(['c0de-uuid']);
    expect(filterSelectItems(runs, 'scout auth')).toEqual([]);
    expect(filterSelectItems(runs, '32m')).toEqual([]);
  });
});

describe('SearchableSelectList typing', () => {
  it('filters by label text, not just the value prefix', () => {
    const list = new SearchableSelectList(runs, 5, theme);
    for (const ch of 'scout') list.handleInput(ch);
    expect(list.selectList.getSelectedItem()?.value).toBe('c0de-uuid');
    expect(list.render(100).join('\n')).not.toContain('reviewer');
  });
});
