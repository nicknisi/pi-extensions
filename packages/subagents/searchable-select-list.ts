/**
 * SearchableSelectList — a SelectList with a search input above it.
 *
 * pi-tui removed `SelectList.searchable`; filtering is now composed manually
 * (the same pattern pi's own model/theme selectors use): route navigation
 * keys to the SelectList and everything else to an Input whose value drives
 * the filter. SelectList.setFilter only prefix-matches `item.value` (here a
 * run UUID), so filtering is done here instead: every whitespace-separated
 * term must appear, case-insensitively, in the item's value, label, or
 * description (ANSI styling stripped).
 */

import {
  Container,
  getKeybindings,
  Input,
  SelectList,
  stripTerminalSequences,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

export function filterSelectItems(items: SelectItem[], query: string): SelectItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items.filter((item) => {
    const haystack = stripTerminalSequences([item.value, item.label, item.description ?? ''].join(' ')).toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export class SearchableSelectList implements Component {
  private container = new Container();
  private searchInput = new Input();
  private readonly maxVisible: number;
  private readonly theme: SelectListTheme;
  private items: SelectItem[];
  selectList: SelectList;

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  /** Current filter text — lets hosts gate action keys (e.g. bare `c`) so they don't eat type-to-filter keystrokes. */
  get filterValue(): string {
    return this.searchInput.getValue();
  }

  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme) {
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.items = items;
    this.selectList = this.createList(items);
    this.container.addChild(this.searchInput);
    this.container.addChild(this.selectList);
  }

  private createList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.maxVisible, this.theme);
    list.onSelect = (item) => this.onSelect?.(item);
    list.onCancel = () => this.onCancel?.();
    return list;
  }

  /** Rebuild the visible list from the current filter, keeping `selectedValue` selected when it still matches. */
  private rebuild(selectedValue: string | undefined): void {
    const filtered = filterSelectItems(this.items, this.searchInput.getValue());
    this.container.removeChild(this.selectList);
    this.selectList = this.createList(filtered);
    if (selectedValue) {
      const selectedIndex = filtered.findIndex((item) => item.value === selectedValue);
      if (selectedIndex >= 0) this.selectList.setSelectedIndex(selectedIndex);
    }
    this.container.addChild(this.selectList);
  }

  setItems(items: SelectItem[]): void {
    const selectedValue = this.selectList.getSelectedItem()?.value;
    this.items = items;
    this.rebuild(selectedValue);
  }

  render(width: number): string[] {
    return [...this.container.render(width)];
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (
      kb.matches(keyData, 'tui.select.up') ||
      kb.matches(keyData, 'tui.select.down') ||
      kb.matches(keyData, 'tui.select.confirm') ||
      kb.matches(keyData, 'tui.select.cancel')
    ) {
      this.selectList.handleInput(keyData);
    } else {
      const before = this.searchInput.getValue();
      this.searchInput.handleInput(keyData);
      // A changed filter resets the selection to the first match, like SelectList.setFilter.
      if (this.searchInput.getValue() !== before) this.rebuild(undefined);
    }
  }
}
