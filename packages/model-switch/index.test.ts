import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
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
    hasUI?: boolean;
  } = {},
) {
  if (!process.env.PI_CODING_AGENT_DIR) tempAgentDir();

  const shortcuts = new Map<string, ShortcutHandler>();
  const commands = new Map<string, CommandHandler>();
  const setModel = vi.fn(async () => options.switchResult ?? true);
  const notify = vi.fn();
  const custom = vi.fn(async () => options.customResult ?? null);
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
    modelRegistry: {
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
    ui: { notify, custom },
  } as unknown as ExtensionContext;

  modelCycle(pi);
  return { shortcuts, commands, setModel, notify, custom, ctx };
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
});
