import type { SelectListTheme } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { SearchableSelectList } from './searchable-select-list.js';

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
