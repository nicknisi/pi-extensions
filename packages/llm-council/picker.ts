import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  SelectList,
  SettingsList,
  Text,
  fuzzyFilter,
  getKeybindings,
  matchesKey,
  type Component,
  type Focusable,
  type SettingItem,
} from '@earendil-works/pi-tui';
import { THINKING_LEVELS, type CouncilSelection } from './selection.js';

export interface PickerResult {
  selection: CouncilSelection;
  saveDefault: boolean;
}

/** A searchable checklist for members, or a single choice for the synthesizer. */
function modelPicker(
  ctx: ExtensionContext,
  theme: Theme,
  references: string[],
  multiple: boolean,
  done: (value?: string[]) => void,
  getFocused: () => boolean,
  keybindings: ReturnType<typeof getKeybindings>,
): Component {
  const available = ctx.modelRegistry.getAvailable();
  const key = (model: (typeof available)[number]) => `${model.provider}/${model.id}`;
  const scoped = new Set(ctx.scopedModels.map(({ model }) => key(model)));
  const selected = references.map((reference) => {
    if (available.some((model) => key(model) === reference)) return reference;
    const matches = available.filter((model) => model.id === reference);
    return matches.length === 1 ? key(matches[0]!) : reference;
  });
  const choices = available.map((model) => ({
    value: key(model),
    name: `${model.name || model.id} · ${model.provider}`,
  }));
  // Keep unresolved configured members removable instead of silently dropping them.
  for (const reference of selected) {
    if (!choices.some((choice) => choice.value === reference))
      choices.push({ value: reference, name: `${reference} · unavailable or ambiguous` });
  }
  const priority = (value: string) => (selected.includes(value) ? 0 : scoped.has(value) ? 1 : 2);
  choices.sort((a, b) => priority(a.value) - priority(b.value) || a.name.localeCompare(b.name));
  const label = (choice: (typeof choices)[number]) =>
    `${selected.includes(choice.value) ? '[x]' : '[ ]'} ${choice.name}`;
  const items = choices.map((choice) => ({ value: choice.value, label: label(choice) }));
  const search = new Input();
  const heading = new Text('', 0, 0);
  const detail = new Text('', 0, 1);
  const help = new Text(
    theme.fg(
      'dim',
      multiple
        ? 'Type to search · Space toggles · Enter keeps choices · Esc goes back without changes'
        : 'Type to search · Enter selects · Esc goes back',
    ),
    0,
    1,
  );
  let list: SelectList;
  function rebuild(): void {
    list = new SelectList(
      fuzzyFilter(items, search.getValue(), (item) => `${item.label} ${item.value}`),
      10,
      getSelectListTheme(),
      {
        minPrimaryColumnWidth: 1,
        maxPrimaryColumnWidth: Number.MAX_SAFE_INTEGER,
      },
    );
  }
  rebuild();
  return {
    render: (width) => {
      search.focused = getFocused();
      heading.setText(
        theme.fg(
          'accent',
          multiple ? `Members · ${selected.length} selected` : 'Synthesizer · Combines the member answers',
        ),
      );
      detail.setText(
        theme.fg(
          'muted',
          list.getSelectedItem()?.value ??
            (available.length
              ? 'No matching models. Try a name, provider, or model ID.'
              : 'No available models. Connect a provider with /login.'),
        ),
      );
      return [
        ...heading.render(width),
        ...search.render(width),
        ...(list.getSelectedItem() ? list.render(width) : []),
        ...detail.render(width),
        ...help.render(width),
      ];
    },
    invalidate: () => list.invalidate(),
    handleInput: (data) => {
      const kb = keybindings;
      if (kb.matches(data, 'tui.select.cancel')) done();
      else if (multiple && kb.matches(data, 'tui.select.confirm')) done(selected);
      else if ((multiple && matchesKey(data, 'space')) || kb.matches(data, 'tui.select.confirm')) {
        const item = list.getSelectedItem();
        if (!item) return;
        if (!multiple) {
          done([item.value]);
          return;
        }
        const index = selected.indexOf(item.value);
        if (index === -1) selected.push(item.value);
        else selected.splice(index, 1);
        item.label = label(choices.find((choice) => choice.value === item.value)!);
      } else if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) list.handleInput(data);
      else {
        const query = search.getValue();
        search.handleInput(data);
        if (search.getValue() !== query) rebuild();
      }
    },
  };
}

export class CouncilPicker implements Component, Focusable {
  focused = false;
  private container = new Container();
  private settings!: SettingsList;
  private heading = new Text('', 0, 1);
  private errorText = new Text('', 0, 0);
  private help = new Text('', 0, 1);
  private selection: CouncilSelection;
  private error = '';

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly theme: Theme,
    selection: CouncilSelection,
    private readonly done: (result: PickerResult | null) => void,
    private readonly keybindings = getKeybindings(),
  ) {
    this.selection = { ...selection, models: [...selection.models] };
    this.rebuild();
  }

  private rebuild(): void {
    const available = this.ctx.modelRegistry.getAvailable();
    const name = (reference: string) => {
      const model = available.find((model) => `${model.provider}/${model.id}` === reference);
      return model ? `${model.name || model.id} · ${model.provider}` : reference;
    };
    const items: SettingItem[] = [
      {
        id: 'apply',
        label: 'Save lineup',
        currentValue: 'this session only',
        values: ['this session only', 'apply'],
        description: 'Save this lineup without running any models. Your main chat model stays unchanged.',
      },
      {
        id: 'members',
        label: `Members (${this.selection.models.length})`,
        currentValue: this.selection.models.map(name).join(' + '),
        description: `Each member answers independently.\n${this.selection.models.join('\n')}`,
        submenu: (_current, close) =>
          modelPicker(
            this.ctx,
            this.theme,
            this.selection.models,
            true,
            (models) => {
              if (models) this.selection.models = models;
              close(models ? 'selected' : undefined);
            },
            () => this.focused,
            this.keybindings,
          ),
      },
      {
        id: 'chairman',
        label: 'Synthesizer',
        currentValue: name(this.selection.chairman),
        description: `Combines the member answers. Can also be a member.\n${this.selection.chairman}`,
        submenu: (_current, close) =>
          modelPicker(
            this.ctx,
            this.theme,
            [this.selection.chairman],
            false,
            (models) => close(models?.[0]),
            () => this.focused,
            this.keybindings,
          ),
      },
      {
        id: 'memberThinking',
        label: 'Member thinking',
        currentValue: this.selection.memberThinking ?? 'default',
        values: ['default', ...THINKING_LEVELS],
        description: 'Higher thinking can take longer and use more tokens. Pi adjusts it to each model.',
      },
      {
        id: 'chairmanThinking',
        label: 'Synthesizer thinking',
        currentValue: this.selection.chairmanThinking ?? 'default',
        values: ['default', ...THINKING_LEVELS],
      },
      {
        id: 'save',
        label: 'Save as global default…',
        currentValue: '',
        values: ['', 'save'],
        description: 'Also use this lineup in other sessions. Asks for confirmation before updating the global config.',
      },
    ];
    this.settings = new SettingsList(
      items,
      8,
      getSettingsListTheme(),
      (id, value) => {
        this.error = '';
        if (id === 'chairman') this.selection.chairman = value;
        else if (id === 'memberThinking' || id === 'chairmanThinking') {
          this.selection[id] = value === 'default' ? null : value;
          return;
        } else if (id === 'apply' || id === 'save') {
          if (this.selection.models.length === 0) this.error = 'Select at least one member before continuing.';
          else {
            this.done({ selection: this.selection, saveDefault: id === 'save' });
            return;
          }
        }
        this.rebuild();
      },
      () => this.done(null),
    );
    this.container.clear();
    this.container.addChild(this.heading);
    this.container.addChild(this.settings);
    this.container.addChild(this.errorText);
    this.container.addChild(this.help);
  }

  render(width: number): string[] {
    this.heading.setText(this.theme.fg('accent', this.theme.bold('Council settings')));
    this.errorText.setText(this.theme.fg('error', this.error));
    this.help.setText(this.theme.fg('dim', 'Save changes the lineup only · /council asks a question and runs it'));
    return this.container.render(width);
  }
  handleInput(data: string): void {
    this.settings.handleInput(data);
  }
  invalidate(): void {
    this.container.invalidate();
  }
}
