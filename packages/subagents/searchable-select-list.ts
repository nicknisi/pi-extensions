/**
 * SearchableSelectList — a SelectList with a search input above it.
 *
 * pi-tui removed `SelectList.searchable`; filtering is now composed manually
 * (the same pattern pi's own model/theme selectors use): route navigation
 * keys to the SelectList and everything else to an Input whose value drives
 * `setFilter()`.
 */

import {
  Container,
  getKeybindings,
  Input,
  SelectList,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

export class SearchableSelectList implements Component {
  private container = new Container();
  private searchInput = new Input();
  private readonly maxVisible: number;
  private readonly theme: SelectListTheme;
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
    this.selectList = new SelectList(items, maxVisible, theme);
    this.selectList.onSelect = (item) => this.onSelect?.(item);
    this.selectList.onCancel = () => this.onCancel?.();
    this.container.addChild(this.searchInput);
    this.container.addChild(this.selectList);
  }

  setItems(items: SelectItem[]): void {
    const selectedValue = this.selectList.getSelectedItem()?.value;
    const filter = this.searchInput.getValue();
    const filteredItems = items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));

    this.container.removeChild(this.selectList);
    this.selectList = new SelectList(items, this.maxVisible, this.theme);
    this.selectList.onSelect = (item) => this.onSelect?.(item);
    this.selectList.onCancel = () => this.onCancel?.();
    this.selectList.setFilter(filter);
    if (selectedValue) {
      const selectedIndex = filteredItems.findIndex((item) => item.value === selectedValue);
      if (selectedIndex >= 0) this.selectList.setSelectedIndex(selectedIndex);
    }
    this.container.addChild(this.selectList);
  }

  render(width: number): string[] {
    return this.container.render(width);
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
      this.searchInput.handleInput(keyData);
      this.selectList.setFilter(this.searchInput.getValue());
    }
  }
}
