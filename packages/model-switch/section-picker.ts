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
    this.selectList.onSelect = (item) => this.done(item.value);
    this.selectList.onCancel = () => this.done(null);

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

  private switchSection(direction: 1 | -1): void {
    this.activeSectionIndex = (this.activeSectionIndex + direction + this.sections.length) % this.sections.length;
    this.searchInput.setValue('');
    this.selectList = new SelectList(this.sections[this.activeSectionIndex]?.items ?? [], 10, this.selectTheme);
    this.selectList.onSelect = (item) => this.done(item.value);
    this.selectList.onCancel = () => this.done(null);
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
      this.selectList.setFilter(this.searchInput.getValue());
    }
  }
}
