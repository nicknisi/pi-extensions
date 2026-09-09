import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadModelSwitchConfig, modelCycleConfigPath } from './config.js';
import { SectionPicker } from './section-picker.js';
import modelCycle from './index.js';

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

type ShortcutHandler = (ctx: ExtensionContext) => Promise<void> | void;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-switch-handler-'));
  tempDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function writeConfig(sections: Record<string, string[]>): string {
  const dir = tempAgentDir();
  const configDir = join(dir, 'configs');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'model-switch.json'), JSON.stringify({ sections }));
  return dir;
}

function writeKeybindings(value: unknown): string {
  const dir = tempAgentDir();
  writeFileSync(join(dir, 'keybindings.json'), JSON.stringify(value));
  return dir;
}

function harness(
  options: {
    current?: Model<Api>;
    models?: Model<Api>[];
    unauthenticated?: string[];
    switchResult?: boolean;
    customResult?: string | null;
    selectResult?: string;
    inputResult?: string | undefined;
    mode?: ExtensionContext['mode'];
    hasUI?: boolean;
  } = {},
) {
  if (!process.env.PI_CODING_AGENT_DIR) tempAgentDir();

  const shortcuts = new Map<string, ShortcutHandler>();
  const commands = new Map<string, CommandHandler>();
  const setModel = vi.fn(async () => options.switchResult ?? true);
  const notify = vi.fn();
  const custom = vi.fn(async () => options.customResult ?? null);
  const select = vi.fn(async () => options.selectResult);
  const input = vi.fn(async () => options.inputResult);
  const models = options.models ?? [];
  const byReference = new Map(models.map((item) => [`${item.provider}/${item.id}`, item]));
  const unauthenticated = new Set(options.unauthenticated ?? []);

  const pi = {
    registerShortcut(key: string, shortcut: { handler: ShortcutHandler }) {
      shortcuts.set(key, shortcut.handler);
    },
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
    setModel,
  } as unknown as ExtensionAPI;

  const ctx = {
    model: options.current,
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? 'tui',
    modelRegistry: {
      getAvailable: () => models.filter((item) => !unauthenticated.has(`${item.provider}/${item.id}`)),
      find(provider: string, modelId: string) {
        return byReference.get(`${provider}/${modelId}`);
      },
      async getApiKeyAndHeaders(item: Model<Api>) {
        const reference = `${item.provider}/${item.id}`;
        return unauthenticated.has(reference)
          ? { ok: false as const, error: 'not authenticated' }
          : { ok: true as const, apiKey: 'test' };
      },
    },
    ui: { notify, custom, select, input },
  } as unknown as ExtensionContext;

  modelCycle(pi);
  return { shortcuts, commands, setModel, notify, custom, select, input, ctx };
}

beforeEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('model-switch extension', () => {
  it('registers default cycle and picker shortcuts plus the picker command', () => {
    const { shortcuts, commands } = harness();

    expect([...shortcuts.keys()]).toEqual(['ctrl+shift+m', 'ctrl+shift+alt+m', 'ctrl+shift+l']);
    expect([...commands.keys()]).toEqual(['model-switch']);
  });

  it('registers extension-owned shortcuts from keybindings.json', () => {
    writeKeybindings({
      'model-switch.cycleForward': 'ctrl+alt+n',
      'model-switch.cycleBackward': 'ctrl+alt+b',
      'model-switch.select': 'ctrl+alt+l',
    });
    const { shortcuts } = harness();

    expect([...shortcuts.keys()]).toEqual(['ctrl+alt+n', 'ctrl+alt+b', 'ctrl+alt+l']);
  });

  it('cycles within the section containing the current model', async () => {
    const current = model('provider', 'work-a');
    const next = model('provider', 'work-b');
    const personalModel = model('provider', 'personal-a');
    writeConfig({
      work: ['provider/work-a', 'provider/work-b'],
      personal: ['provider/personal-a'],
    });
    const { shortcuts, setModel, ctx } = harness({ current, models: [current, next, personalModel] });

    await shortcuts.get('ctrl+shift+m')!(ctx);

    expect(setModel).toHaveBeenCalledWith(next);
    expect(setModel).not.toHaveBeenCalledWith(personalModel);
  });

  it('enters the first section at the boundary when current is outside all sections', async () => {
    const outside = model('other', 'outside');
    const first = model('provider', 'work-a');
    const last = model('provider', 'work-b');
    writeConfig({ work: ['provider/work-a', 'provider/work-b'] });
    const { shortcuts, setModel, ctx } = harness({ current: outside, models: [first, last] });

    await shortcuts.get('ctrl+shift+m')!(ctx);
    expect(setModel).toHaveBeenLastCalledWith(first);

    await shortcuts.get('ctrl+shift+alt+m')!(ctx);
    expect(setModel).toHaveBeenLastCalledWith(last);
  });

  it('skips unavailable models before switching', async () => {
    const first = model('provider', 'first');
    const second = model('provider', 'second');
    writeConfig({ work: ['provider/first', 'provider/second'] });
    const { shortcuts, setModel, ctx } = harness({
      models: [first, second],
      unauthenticated: ['provider/first'],
    });

    await shortcuts.get('ctrl+shift+m')!(ctx);

    expect(setModel).toHaveBeenCalledWith(second);
  });

  it('warns when cycling through a section with no usable models', async () => {
    writeConfig({ work: ['missing/model'] });
    const { shortcuts, setModel, notify, ctx } = harness();

    await shortcuts.get('ctrl+shift+m')!(ctx);

    expect(setModel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('No usable models in section "work"'), 'warning');
  });

  it('warns for invalid config or empty sections', async () => {
    const dir = tempAgentDir();
    const configDir = join(dir, 'configs');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'model-switch.json'), '{ nope');
    const invalid = harness();

    await invalid.shortcuts.get('ctrl+shift+m')!(invalid.ctx);
    expect(invalid.setModel).not.toHaveBeenCalled();
    expect(invalid.notify).toHaveBeenCalledWith(
      expect.stringContaining(join(dir, 'configs', 'model-switch.json')),
      'warning',
    );

    writeConfig({});
    const empty = harness();
    await empty.shortcuts.get('ctrl+shift+m')!(empty.ctx);
    expect(empty.setModel).not.toHaveBeenCalled();
  });

  it('opens the fuzzy picker via command and switches the selected model', async () => {
    const target = model('provider', 'target');
    writeConfig({ work: ['provider/target'] });
    const { commands, setModel, custom, ctx } = harness({
      models: [target],
      customResult: 'provider/target',
    });

    await commands.get('model-switch')!('', ctx);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith(target);
  });

  it('opens the fuzzy picker via the configured select shortcut', async () => {
    const target = model('provider', 'target');
    writeConfig({ work: ['provider/target'] });
    const { shortcuts, custom, ctx } = harness({ models: [target], customResult: 'provider/target' });

    await shortcuts.get('ctrl+shift+l')!(ctx);

    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('does not switch when the picker is cancelled or UI is unavailable', async () => {
    const target = model('provider', 'target');
    writeConfig({ work: ['provider/target'] });
    const cancelled = harness({ models: [target], customResult: null });

    await cancelled.commands.get('model-switch')!('', cancelled.ctx);
    expect(cancelled.setModel).not.toHaveBeenCalled();

    const noUi = harness({ models: [target], hasUI: false, customResult: 'provider/target' });
    await noUi.commands.get('model-switch')!('', noUi.ctx);
    expect(noUi.custom).not.toHaveBeenCalled();
    expect(noUi.setModel).not.toHaveBeenCalled();
  });

  it('warns when the picker has no usable models across all sections', async () => {
    writeConfig({ work: ['missing/model'], personal: ['also/missing'] });
    const { commands, setModel, notify, custom, ctx } = harness();

    await commands.get('model-switch')!('', ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('No configured models are available'), 'warning');
  });

  it('warns when Pi rejects a picker selection', async () => {
    const target = model('provider', 'target');
    writeConfig({ work: ['provider/target'] });
    const { commands, notify, ctx } = harness({
      models: [target],
      customResult: 'provider/target',
      switchResult: false,
    });

    await commands.get('model-switch')!('', ctx);

    expect(notify).toHaveBeenCalledWith('Could not switch to provider/target', 'warning');
  });

  it('picks from available models and appends to the chosen section without switching', async () => {
    const target = model('provider', 'new');
    writeConfig({ work: ['provider/old'], personal: [] });
    const { commands, ctx, custom, select, notify, setModel } = harness({
      models: [target, model('locked', 'hidden')],
      unauthenticated: ['locked/hidden'],
      customResult: 'provider/new',
      selectResult: 'personal',
    });

    await commands.get('model-switch')!('add', ctx);

    expect(select).toHaveBeenCalledWith('Add provider/new to section', ['work', 'personal']);
    expect(loadModelSwitchConfig()).toEqual({
      ok: true,
      config: {
        sections: [
          { name: 'work', models: ['provider/old'] },
          { name: 'personal', models: ['provider/new'] },
        ],
      },
    });
    expect(setModel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Added provider/new to "personal"', 'info');

    // Exercise the actual picker factory, not just the mocked dialog result.
    const factory = (custom.mock.calls as unknown[][])[0]![0] as Parameters<ExtensionContext['ui']['custom']>[0];
    const done = vi.fn();
    const picker = (await factory(
      {} as never,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      {} as never,
      done,
    )) as SectionPicker;
    expect(picker.render(160).join('\n')).not.toContain('locked/hidden');
    for (const key of 'new') picker.handleInput(key);
    picker.handleInput('\r');
    expect(done).toHaveBeenCalledWith('provider/new');
  });

  it('saves the current model and skips a duplicate on the next invocation', async () => {
    writeConfig({ work: [] });
    const { commands, ctx, custom, notify, setModel } = harness({
      current: model('provider', 'current'),
      selectResult: 'work',
    });

    await commands.get('model-switch')!('add-current', ctx);
    await commands.get('model-switch')!('add-current', ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    expect(loadModelSwitchConfig()).toEqual({
      ok: true,
      config: { sections: [{ name: 'work', models: ['provider/current'] }] },
    });
    expect(notify).toHaveBeenLastCalledWith('provider/current is already in "work"', 'info');
  });

  it('creates a first section when no config exists', async () => {
    const { commands, ctx, input } = harness({ current: model('provider', 'current'), inputResult: ' personal ' });

    await commands.get('model-switch')!('add-current', ctx);

    expect(input).toHaveBeenCalled();
    expect(loadModelSwitchConfig()).toEqual({
      ok: true,
      config: { sections: [{ name: 'personal', models: ['provider/current'] }] },
    });
  });

  it.each(['add', 'add-current'])('does not write when the section selection is cancelled for %s', async (command) => {
    writeConfig({ work: [] });
    const content = readFileSync(modelCycleConfigPath(), 'utf8');
    const target = model('provider', 'new');
    const { commands, ctx, notify } = harness({ current: target, models: [target], customResult: 'provider/new' });

    await commands.get('model-switch')!(command, ctx);

    expect(readFileSync(modelCycleConfigPath(), 'utf8')).toBe(content);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not ask for a section or write when the catalog picker is cancelled', async () => {
    const { commands, ctx, select, input } = harness({ models: [model('provider', 'new')] });

    await commands.get('model-switch')!('add', ctx);

    expect(select).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(existsSync(modelCycleConfigPath())).toBe(false);
  });

  it.each([undefined, '', '   '])('does not create a config without a section name: %s', async (inputResult) => {
    const { commands, ctx } = harness({ current: model('provider', 'new'), inputResult });

    await commands.get('model-switch')!('add-current', ctx);

    expect(existsSync(modelCycleConfigPath())).toBe(false);
  });

  it.each(['add', 'add-current'])('does not prompt or write without UI for %s', async (command) => {
    const target = model('provider', 'new');
    const { commands, ctx, custom, select, input } = harness({
      hasUI: false,
      current: target,
      models: [target],
      customResult: 'provider/new',
      inputResult: 'work',
    });

    await commands.get('model-switch')!(command, ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(existsSync(modelCycleConfigPath())).toBe(false);
  });

  it('warns when no current model or available catalog model exists', async () => {
    const { commands, ctx, notify, custom, select } = harness();

    await commands.get('model-switch')!('add-current', ctx);
    expect(notify).toHaveBeenLastCalledWith('No model selected to add', 'warning');
    await commands.get('model-switch')!('add', ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('No available models to add'), 'warning');
    expect(custom).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(existsSync(modelCycleConfigPath())).toBe(false);
  });

  it('refuses custom catalog UI in RPC mode', async () => {
    const { commands, ctx, notify, custom } = harness({ mode: 'rpc' });

    await commands.get('model-switch')!('add', ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('/model-switch add requires the terminal UI', 'warning');
  });

  it.each(['add', 'add-current'])('refuses malformed config before prompting for %s', async (command) => {
    writeConfig({ work: [] });
    writeFileSync(modelCycleConfigPath(), '{ nope');
    const { commands, ctx, notify, custom, select } = harness({ current: model('provider', 'new') });

    await commands.get('model-switch')!(command, ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(modelCycleConfigPath()), 'warning');
    expect(readFileSync(modelCycleConfigPath(), 'utf8')).toBe('{ nope');
  });

  it('retains edits made while the section prompt was open', async () => {
    writeConfig({ work: [] });
    const { commands, ctx, select } = harness({ current: model('provider', 'new') });
    select.mockImplementation(async () => {
      writeFileSync(modelCycleConfigPath(), JSON.stringify({ sections: { work: ['provider/edited'], personal: [] } }));
      return 'work';
    });

    await commands.get('model-switch')!('add-current', ctx);

    expect(loadModelSwitchConfig()).toEqual({
      ok: true,
      config: {
        sections: [
          { name: 'work', models: ['provider/edited', 'provider/new'] },
          { name: 'personal', models: [] },
        ],
      },
    });
  });

  it('reports save errors instead of claiming the model was added', async () => {
    writeConfig({ work: [] });
    const { commands, ctx, select, notify } = harness({ current: model('provider', 'new') });
    select.mockImplementation(async () => {
      writeFileSync(modelCycleConfigPath(), '{ broken during selection');
      return 'work';
    });

    await commands.get('model-switch')!('add-current', ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Could not update model-switch config'), 'warning');
  });

  it('shows usage for unknown arguments without opening a picker', async () => {
    const { commands, ctx, notify, custom } = harness();

    await commands.get('model-switch')!('typo', ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Usage: /model-switch [add | add-current]', 'warning');
  });
});
