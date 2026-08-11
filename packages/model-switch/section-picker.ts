import {
  Container,
  Input,
  SelectList,
  Text,
  getKeybindings,
  matchesKey,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

export interface PickerSection {
  name: string;
  items: SelectItem[];
}

export class SectionPicker implements Component {
  private container = new Container();
  private tabBar = new Text('', 0, 0);
  private searchInput = new Input();
  private selectList: SelectList;
  private activeSectionIndex = 0;
  private readonly selectTheme: SelectListTheme;

  constructor(
    private readonly sections: PickerSection[],
    private readonly theme: Theme,
    private readonly done: (value: string | null) => void,
  ) {
    this.selectTheme = {
      selectedPrefix: (text) => theme.fg('accent', text),
      selectedText: (text) => theme.fg('accent', text),
      description: (text) => theme.fg('muted', text),
      scrollInfo: (text) => theme.fg('dim', text),
      noMatch: (text) => theme.fg('warning', text),
    };

    this.selectList = new SelectList(sections[0]?.items ?? [], 10, this.selectTheme);
    this.wireSelectList();

    this.container.addChild(this.tabBar);
    this.container.addChild(this.searchInput);
    this.container.addChild(this.selectList);
    this.renderTabBar();
  }

  private renderTabBar(): void {
    const parts = this.sections.map((section, index) => {
      const label = section.name;
      return index === this.activeSectionIndex
        ? this.theme.fg('accent', this.theme.bold(`[${label}]`))
        : this.theme.fg('dim', ` ${label} `);
    });
    this.tabBar.setText(parts.join(''));
  }

  private wireSelectList(): void {
    this.selectList.onSelect = (item) => this.done(item.value);
    this.selectList.onCancel = () => this.done(null);
  }

  private switchSection(direction: 1 | -1): void {
    this.activeSectionIndex = (this.activeSectionIndex + direction + this.sections.length) % this.sections.length;
    this.searchInput.setValue('');
    this.rebuildList();
  }

  private filteredItems(): SelectItem[] {
    const query = this.searchInput.getValue().trim().toLowerCase();
    if (query.length === 0) return this.sections[this.activeSectionIndex]?.items ?? [];

    // SelectList.setFilter only matches value.startsWith(query), which can never
    // match a model name inside "provider/modelId" — filter here instead, with a
    // substring match across every section.
    const seen = new Set<string>();
    const matches: SelectItem[] = [];
    for (const section of this.sections) {
      for (const item of section.items) {
        if (seen.has(item.value) || !item.value.toLowerCase().includes(query)) continue;
        seen.add(item.value);
        matches.push({ ...item, description: section.name });
      }
    }
    return matches;
  }

  private rebuildList(): void {
    // Size the primary column to the content so section descriptions never
    // truncate long provider/modelId labels (SelectList caps it at 32 otherwise).
    this.selectList = new SelectList(this.filteredItems(), 10, this.selectTheme, {
      minPrimaryColumnWidth: 1,
      maxPrimaryColumnWidth: Number.MAX_SAFE_INTEGER,
    });
    this.wireSelectList();
    this.container.clear();
    this.container.addChild(this.tabBar);
    this.container.addChild(this.searchInput);
    this.container.addChild(this.selectList);
    this.renderTabBar();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'tab')) {
      this.switchSection(1);
      return;
    }

    const kb = getKeybindings();
    if (
      kb.matches(data, 'tui.select.up') ||
      kb.matches(data, 'tui.select.down') ||
      kb.matches(data, 'tui.select.confirm') ||
      kb.matches(data, 'tui.select.cancel')
    ) {
      this.selectList.handleInput(data);
    } else {
      this.searchInput.handleInput(data);
      this.rebuildList();
    }
  }
}
