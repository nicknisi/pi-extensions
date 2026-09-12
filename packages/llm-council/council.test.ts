import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BorderedLoader,
  initTheme,
  SessionManager,
  type KeybindingsManager,
  type SessionContext,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, getKeybindings, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import councilExtension from './index.js';
import { councilConfigPath, loadCouncil, saveCouncilDefaults } from './config.js';
import { CouncilPicker, type PickerResult } from './picker.js';
import {
  applySelection,
  resolveOverrides,
  restoreSelection,
  SELECTION_ENTRY,
  type CouncilSelection,
} from './selection.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('@nicknisi/pi-shared', async (original) => ({
  ...(await original<typeof import('@nicknisi/pi-shared')>()),
  createSubagentRuntime: () => ({ spawn }),
}));

const fable = 'anthropic/claude-fable-5-1';
const astra = 'openai-codex/gpt-6-astra';
const apiAstra = 'openai/gpt-6-astra';
const selection: CouncilSelection = {
  models: [fable, astra],
  chairman: fable,
  memberThinking: 'high',
  chairmanThinking: 'medium',
};
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
let dir: string;

function writeConfig(value: unknown, path = councilConfigPath()): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function harness(mode: ExtensionContext['mode'] = 'tui') {
  const registerTool = vi.fn();
  const sendMessage = vi.fn();
  const registerMessageRenderer = vi.fn();
  const messages: SessionContext['messages'] = [];
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const entries: { type: 'custom'; customType: string; data: unknown }[] = [];
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    entries.push({ type: 'custom', customType, data });
  });
  const setStatus = vi.fn();
  const setWidget = vi.fn();
  const notify = vi.fn();
  const select = vi.fn<ExtensionContext['ui']['select']>();
  const custom = vi.fn<ExtensionContext['ui']['custom']>();
  const confirm = vi.fn(async () => true);
  const editor = vi.fn<ExtensionContext['ui']['editor']>().mockResolvedValue('Compare designs.');
  const models = [
    { provider: 'anthropic', id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
    { provider: 'openai-codex', id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    { provider: 'openai', id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  ];
  const ctx = {
    cwd: dir,
    isIdle: () => true,
    mode,
    hasUI: mode === 'tui' || mode === 'rpc',
    modelRegistry: { getAvailable: () => models },
    scopedModels: [{ model: models[0] }],
    sessionManager: {
      getBranch: () =>
        [...messages.map((message) => ({ type: 'message', message })), ...entries].map((entry, i) => ({
          ...entry,
          id: String(i),
          parentId: i ? String(i - 1) : null,
        })),
    },
    ui: { setStatus, setWidget, notify, select, custom, confirm, editor, theme },
  } as unknown as ExtensionContext;
  const pi = {
    registerTool,
    sendMessage,
    registerMessageRenderer,
    registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      commands.set(name, definition.handler),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => events.set(name, handler),
    appendEntry,
  } as unknown as ExtensionAPI;
  councilExtension(pi);
  const tool = registerTool.mock.calls[0]![0];
  const run = (args: { models?: string[]; chairman?: string } = {}) =>
    tool.execute('test', { question: 'Compare designs.', ...args }, undefined, vi.fn(), ctx);
  return {
    ctx,
    entries,
    appendEntry,
    setStatus,
    setWidget,
    notify,
    select,
    custom,
    confirm,
    editor,
    messages,
    sendMessage,
    registerMessageRenderer,
    commands,
    events,
    run,
  };
}

function runProgressDialog(h: ReturnType<typeof harness>, cancel = false): void {
  h.custom.mockImplementationOnce(
    (factory) =>
      new Promise((resolve) => {
        const view = factory(
          { requestRender: vi.fn() } as unknown as TUI,
          theme,
          getKeybindings() as KeybindingsManager,
          (result) => {
            void Promise.resolve(view).then((component) => component.dispose?.());
            resolve(result);
          },
        );
        expect(view).toBeInstanceOf(BorderedLoader);
        if (cancel) void Promise.resolve(view).then((component) => component.handleInput?.('\x1b'));
      }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-council-test-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  initTheme('dark', false);
  spawn
    .mockReset()
    .mockResolvedValue({ ok: true, text: 'Answer', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  writeConfig({
    member: {
      council: [{ model: fable, systemPrompt: 'Be skeptical.', label: 'Skeptic' }],
      defaultSystemPrompt: 'Default persona.',
      tools: ['read'],
    },
    chairman: { model: fable, displayName: 'Fable' },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('council selection and execution', () => {
  it('asks a question, runs the selected council with conversation context, and displays its answer', async () => {
    const h = harness();
    h.messages.push({ role: 'user', content: 'The existing design uses SQLite.', timestamp: 1 });
    h.editor.mockResolvedValue('Should we keep it?');
    h.entries.push({ type: 'custom', customType: SELECTION_ENTRY, data: selection });
    runProgressDialog(h);
    await h.commands.get('council')!('', h.ctx);
    expect(h.editor).toHaveBeenCalledTimes(1);
    expect(h.custom).toHaveBeenCalledTimes(1); // Progress only, no launch confirmation.
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.setWidget).toHaveBeenCalledWith(
      'llm-council-question',
      [
        `Members: ${fable} + ${astra}`,
        `Synthesizer: ${fable}`,
        'Conversation context included · /council settings to change models',
      ],
      { placement: 'belowEditor' },
    );
    expect(h.setWidget).toHaveBeenLastCalledWith('llm-council-question', undefined);
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(h.notify.mock.calls.filter(([, level]) => level === 'error')).toEqual([]);
    expect(spawn.mock.calls.map(([args]) => args.model)).toEqual([fable, astra, fable]);
    for (const [args] of spawn.mock.calls) {
      expect(args.prompt).toContain('Should we keep it?');
      expect(args.prompt).toContain('The existing design uses SQLite.');
    }
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'llm-council-result',
        content: expect.stringContaining('Answer'),
        display: true,
      }),
    );
  });

  it('runs explicit questions without prompting and forwards only the compacted active branch', async () => {
    const h = harness();
    const session = SessionManager.inMemory(dir);
    const first = session.appendMessage({ role: 'user', content: 'Old raw history', timestamp: 1 });
    const kept = session.appendMessage({ role: 'user', content: 'Kept context', timestamp: 2 });
    session.appendCompaction('Summary: we chose SQLite.', kept, 100);
    Object.assign(h.ctx, { sessionManager: session });
    runProgressDialog(h);
    await h.commands.get('council')!('Compare designs.', h.ctx);
    expect(h.editor).not.toHaveBeenCalled();
    expect(h.setWidget).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.custom).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls.map(([args]) => args.model)).toEqual([fable, fable]);
    expect(spawn.mock.calls[0]![0].prompt).toContain('Compare designs.');
    expect(spawn.mock.calls[0]![0].prompt).toContain('Summary: we chose SQLite.');
    expect(spawn.mock.calls[0]![0].prompt).toContain('Kept context');
    expect(spawn.mock.calls[0]![0].prompt).not.toContain('Old raw history');
    session.branch(first);
    spawn.mockClear();
    runProgressDialog(h);
    await h.commands.get('council')!('', h.ctx);
    expect(spawn.mock.calls[0]![0].prompt).toContain('Old raw history');
    expect(spawn.mock.calls[0]![0].prompt).not.toContain('Kept context');
  });

  it('does not persist or run when the question is cancelled or empty, and clears the lineup widget', async () => {
    const h = harness();
    h.editor.mockResolvedValueOnce(undefined).mockResolvedValueOnce('   ');
    await h.commands.get('council')!('', h.ctx);
    await h.commands.get('council')!('', h.ctx);
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.setWidget).toHaveBeenLastCalledWith('llm-council-question', undefined);
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('cancels running members without starting synthesis or posting a late result', async () => {
    const h = harness();
    h.entries.push({ type: 'custom', customType: SELECTION_ENTRY, data: selection });
    runProgressDialog(h, true);
    spawn.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: true, text: 'Late answer' }), { once: true });
        }),
    );
    await h.commands.get('council')!('', h.ctx);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls.every(([args]) => args.signal.aborted)).toBe(true);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenLastCalledWith('Council cancelled.', 'info');
  });

  it('displays failed member and synthesizer outcomes instead of claiming success', async () => {
    const h = harness();
    spawn.mockResolvedValue({ ok: false, text: '', error: 'Provider unavailable' });
    h.entries.push({ type: 'custom', customType: SELECTION_ENTRY, data: selection });
    runProgressDialog(h);
    await h.commands.get('council')!('', h.ctx);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(h.sendMessage.mock.calls[0]![0].content).toContain('Council failed');
    expect(h.sendMessage.mock.calls[0]![0].details.members[0].error).toBe('Provider unavailable');
    spawn
      .mockClear()
      .mockResolvedValue({ ok: false, text: 'Partial synthesis', error: 'Connection lost' })
      .mockResolvedValueOnce({ ok: true, text: 'Member answer' });
    h.entries.push({ type: 'custom', customType: SELECTION_ENTRY, data: { ...selection, models: [fable] } });
    runProgressDialog(h);
    await h.commands.get('council')!('', h.ctx);
    expect(spawn).toHaveBeenCalledTimes(2);
    const message = h.sendMessage.mock.calls[1]![0];
    expect(message.content).toContain('Council synthesis failed: Connection lost');
    expect(message.content).toContain('Incomplete synthesis:');
    expect(message.content).toContain('Partial synthesis');
    const renderer = h.registerMessageRenderer.mock.calls[0]![1];
    expect(renderer(message, { expanded: false }, theme).render(100).join('\n')).toContain('Connection lost');
  });

  it('requires fixing an unavailable qualified model instead of choosing another provider or newer variant', async () => {
    const h = harness();
    const models = h.ctx.modelRegistry.getAvailable();
    vi.spyOn(h.ctx.modelRegistry, 'getAvailable').mockReturnValue([
      ...models,
      { ...models[0]!, provider: 'other', id: 'openai-codex/gpt-6' },
    ]);
    h.entries.push({
      type: 'custom',
      customType: SELECTION_ENTRY,
      data: { ...selection, models: ['openai-codex/gpt-6'] },
    });
    runProgressDialog(h);
    await h.commands.get('council')!('Compare designs.', h.ctx);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('/council settings'), 'error');
    expect(h.editor).not.toHaveBeenCalled();
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses configured defaults unchanged when no overrides are supplied', async () => {
    const h = harness();
    await h.run();
    expect(spawn.mock.calls.map(([args]) => args.model)).toEqual([fable, fable]);
    expect(spawn.mock.calls[0]![0]).toMatchObject({ tools: ['read'], systemPrompt: 'Be skeptical.' });
  });

  it('applies per-call overrides without persisting or changing the next run', async () => {
    const h = harness();
    await h.run({ models: [astra], chairman: astra });
    expect(spawn.mock.calls.map(([args]) => args.model)).toEqual([astra, astra]);
    expect(spawn.mock.calls[0]![0].systemPrompt).toBe('Default persona.');
    expect(h.appendEntry).not.toHaveBeenCalled();
    spawn.mockClear();
    await h.run();
    expect(spawn.mock.calls.map(([args]) => args.model)).toEqual([fable, fable]);
  });

  it('restores active-branch selections, clears them on branch navigation, and supports reset', async () => {
    const h = harness();
    h.entries.push({ type: 'custom', customType: SELECTION_ENTRY, data: selection });
    h.events.get('session_start')!({}, h.ctx);
    expect(h.setStatus).toHaveBeenLastCalledWith('llm-council', expect.stringContaining('Council:'));
    await h.run();
    expect(spawn.mock.calls.map(([args]) => args.model)).toEqual([fable, astra, fable]);
    expect(spawn.mock.calls[0]![0].thinkingLevel).toBe('high');
    await h.commands.get('council')!('reset', h.ctx);
    expect(restoreSelection(h.ctx)).toBeUndefined();
    expect(h.setStatus).toHaveBeenLastCalledWith('llm-council', undefined);
    h.entries.splice(0);
    h.events.get('session_tree')!({}, h.ctx);
    expect(h.setStatus).toHaveBeenLastCalledWith('llm-council', undefined);
  });

  it('resolves unique names, asks for ambiguous providers, and preserves the selected provider', async () => {
    const h = harness();
    h.select.mockResolvedValue(astra);
    expect(await resolveOverrides({ models: ['Fable 5.1', 'Astra'] }, h.ctx)).toEqual({ models: [fable, astra] });
    expect(h.select).toHaveBeenCalledWith(expect.any(String), [astra, apiAstra], undefined);
  });

  it('fails before spawning on headless ambiguity, unknown names, or duplicate members', async () => {
    const h = harness('print');
    await expect(h.run({ models: ['Astra'] })).rejects.toThrow('Ambiguous');
    await expect(h.run({ models: ['missing'] })).rejects.toThrow('/login');
    await expect(h.run({ models: [fable, 'Fable 5.1'] })).rejects.toThrow('distinct');
    expect(spawn).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  });

  it('does not start a partial council when model selection is cancelled', async () => {
    const h = harness();
    h.select.mockResolvedValue(undefined);
    await expect(h.run({ models: [fable, 'Astra'] })).rejects.toThrow('cancelled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('serializes ambiguity dialogs across parallel calls and recovers after cancellation', async () => {
    const h = harness();
    let resolveChoice!: (value: string | undefined) => void;
    const firstChoice = new Promise<string | undefined>((resolve) => {
      resolveChoice = resolve;
    });
    h.select.mockReturnValueOnce(firstChoice).mockResolvedValueOnce(astra);
    const first = h.run({ models: ['Astra'] });
    const rejected = expect(first).rejects.toThrow('cancelled');
    const second = h.run({ models: ['Astra'] });
    await vi.waitFor(() => expect(h.select).toHaveBeenCalledTimes(1));
    resolveChoice(undefined);
    await rejected;
    await second;
    expect(h.select).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls.map(([args]) => args.model)).toEqual([astra, fable]);
  });

  it('honors aborts before resolving and spawning', async () => {
    const h = harness();
    await expect(resolveOverrides({ models: [fable] }, h.ctx, AbortSignal.abort())).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('applies picker results only on Apply and leaves cancelled edits untouched', async () => {
    const h = harness();
    h.custom.mockResolvedValue(null);
    await h.commands.get('council')!('settings', h.ctx);
    expect(h.appendEntry).not.toHaveBeenCalled();
    h.custom.mockResolvedValue({ selection, saveDefault: false });
    await h.commands.get('council')!('settings', h.ctx);
    expect(h.editor).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(restoreSelection(h.ctx)).toEqual(selection);
    expect(loadCouncil(dir).member.council).toHaveLength(1);
  });

  it('requires explicit confirmation to save defaults and guards non-TUI modes', async () => {
    const h = harness();
    h.custom.mockResolvedValue({ selection, saveDefault: true });
    h.confirm.mockResolvedValue(false);
    await h.commands.get('council')!('settings', h.ctx);
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(loadCouncil(dir).member.council).toHaveLength(1);
    const rpc = harness('rpc');
    await rpc.commands.get('council')!('', rpc.ctx);
    expect(rpc.custom).not.toHaveBeenCalled();
  });
});

describe('config persistence', () => {
  it('reloads defaults immediately, preserves unrelated settings/personas, and respects project overrides', async () => {
    writeConfig({
      shared: { spinner: { interval: 100 } },
      extra: 'keep',
      member: {
        council: [{ model: fable, systemPrompt: 'Original persona.' }],
        tools: ['read'],
        defaultSystemPrompt: 'New persona.',
      },
      chairman: { model: fable, displayName: 'Old name', systemPrompt: 'Synthesize.' },
    });
    await saveCouncilDefaults({ ...selection, chairman: astra });
    const saved = JSON.parse(readFileSync(councilConfigPath(), 'utf8'));
    expect(saved).toMatchObject({
      extra: 'keep',
      shared: { spinner: { interval: 100 } },
      member: { tools: ['read'] },
      chairman: { systemPrompt: 'Synthesize.' },
    });
    expect(loadCouncil(dir).member.council.map((m) => m.systemPrompt)).toEqual(['Original persona.', 'New persona.']);
    expect(loadCouncil(dir).chairman.displayName).toBeUndefined();
    writeConfig({ chairman: { model: apiAstra } }, join(dir, '.pi/configs/llm-council.json'));
    expect(loadCouncil(dir).chairman.model).toBe(apiAstra);
    expect(applySelection(loadCouncil(dir), selection).chairman.model).toBe(fable);
  });

  it('preserves personas and labels when a bare configured model ID becomes canonical', async () => {
    writeConfig({
      member: {
        council: [{ model: 'claude-fable-5-1', systemPrompt: 'Keep me.', label: 'Skeptic', displayName: 'Fable' }],
      },
      chairman: { model: 'claude-fable-5-1', displayName: 'Chair Fable' },
    });
    expect(applySelection(loadCouncil(dir), selection).member.council[0]).toMatchObject({
      model: fable,
      systemPrompt: 'Keep me.',
      label: 'Skeptic',
    });
    await saveCouncilDefaults(selection);
    expect(loadCouncil(dir).member.council[0]).toMatchObject({
      model: fable,
      systemPrompt: 'Keep me.',
      label: 'Skeptic',
      displayName: 'Fable',
    });
    expect(loadCouncil(dir).chairman.displayName).toBe('Chair Fable');
  });

  it('preserves default thinking when saving and reloading global or project settings', async () => {
    await saveCouncilDefaults({ ...selection, memberThinking: null, chairmanThinking: null });
    expect(loadCouncil(dir).member.thinking).toBeNull();
    expect(loadCouncil(dir).chairman.thinking).toBeNull();
    writeConfig({ member: { thinking: 'high' }, chairman: { thinking: 'high' } });
    writeConfig(
      { member: { thinking: null }, chairman: { thinking: null } },
      join(dir, '.pi/configs/llm-council.json'),
    );
    expect(loadCouncil(dir).member.thinking).toBeNull();
    expect(loadCouncil(dir).chairman.thinking).toBeNull();
  });

  it('updates symlink targets without replacing links and refuses to overwrite malformed config', async () => {
    const target = join(dir, 'real-config.json');
    writeFileSync(target, '{"extra":true}');
    rmSync(councilConfigPath());
    symlinkSync(target, councilConfigPath());
    await saveCouncilDefaults(selection);
    expect(lstatSync(councilConfigPath()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8')).extra).toBe(true);
    writeFileSync(target, '{ broken');
    await expect(saveCouncilDefaults(selection)).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{ broken');
  });
});

function down(picker: CouncilPicker, count: number): void {
  for (let i = 0; i < count; i++) picker.handleInput('\x1b[B');
}

function type(picker: CouncilPicker, text: string): void {
  for (const char of text) picker.handleInput(char);
}

function expectFits(picker: CouncilPicker): void {
  for (const width of [40, 80, 120])
    expect(picker.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
}

describe('native council picker keyboard behavior', () => {
  it('defaults to saving the lineup in settings, never removing a member', () => {
    const h = harness();
    const done = vi.fn<(result: PickerResult | null) => void>();
    const picker = new CouncilPicker(h.ctx, theme, selection, done);
    expectFits(picker);
    picker.handleInput('\r');
    expect(done).toHaveBeenCalledWith({ selection, saveDefault: false });
  });

  it('immediately searches all providers, keeps selected models visible, and toggles while searching', () => {
    const h = harness();
    const done = vi.fn<(result: PickerResult | null) => void>();
    const picker = new CouncilPicker(h.ctx, theme, { ...selection, models: [fable] }, done);
    down(picker, 1);
    picker.handleInput('\r'); // Members
    const initial = picker.render(120).join('\n');
    expect(initial).toContain('[x] Claude Fable 5.1');
    expect(initial).toContain('[ ] GPT-6 Astra · openai');
    expect(initial).toContain('[ ] GPT-6 Astra · openai-codex');
    expect(initial).not.toContain('Show all available models');
    type(picker, 'openai-codex');
    expect(picker.render(120).join('\n')).not.toContain('Claude Fable');
    picker.handleInput(' '); // Toggle without losing the query or selection
    picker.invalidate();
    const checked = picker.render(120).join('\n');
    expect(checked).toContain('[x] GPT-6 Astra · openai-codex');
    expect(checked).toContain('Members · 2 selected');
    expect(checked).toContain(astra);
    expect(checked).not.toContain('Claude Fable');
    expectFits(picker);
    picker.handleInput('\r'); // Keep choices, return to Apply
    expect(picker.render(120).join('\n')).toContain('Members (2)');
    expectFits(picker);
    expect(done).not.toHaveBeenCalled();
    picker.handleInput('\r'); // Apply
    expect(done).toHaveBeenCalledWith({ selection, saveDefault: false });
  });

  it('keeps the highlighted provider when only the search cursor moves', () => {
    const h = harness();
    const done = vi.fn();
    const picker = new CouncilPicker(h.ctx, theme, { ...selection, models: [fable] }, done);
    down(picker, 1);
    picker.handleInput('\r');
    type(picker, 'Astra');
    down(picker, 1); // Codex, not API
    picker.handleInput('\x1b[D'); // Move the search cursor without changing the query
    picker.handleInput(' ');
    picker.handleInput('\r');
    picker.handleInput('\r');
    expect(done).toHaveBeenCalledWith({ selection, saveDefault: false });
  });

  it('forwards focus to the active search input for IME cursor positioning', () => {
    const h = harness();
    const picker = Object.assign(new CouncilPicker(h.ctx, theme, selection, vi.fn()), { focused: true });
    down(picker, 1);
    picker.handleInput('\r');
    expect(picker.render(100).join('\n')).toContain(CURSOR_MARKER);
    picker.focused = false;
    expect(picker.render(100).join('\n')).not.toContain(CURSOR_MARKER);
    picker.focused = true;
    picker.handleInput('\x1b');
    expect(picker.render(100).join('\n')).not.toContain(CURSOR_MARKER);
  });

  it('cancels checklist edits on Escape and discards the whole draft on the main screen', () => {
    const h = harness();
    const done = vi.fn();
    const picker = new CouncilPicker(h.ctx, theme, selection, done);
    down(picker, 1);
    picker.handleInput('\r');
    picker.handleInput(' '); // Uncheck a member
    expect(picker.render(120).join('\n')).toContain('Members · 1 selected');
    picker.handleInput('\x1b'); // Cancel submenu
    expect(picker.render(120).join('\n')).toContain('Members (2)');
    picker.handleInput('\x1b'); // Cancel picker
    expect(done).toHaveBeenCalledWith(null);
    expect(selection.models).toEqual([fable, astra]);
  });

  it('prevents duplicate members and blocks applying an empty lineup', () => {
    const h = harness();
    const done = vi.fn();
    const picker = new CouncilPicker(h.ctx, theme, { ...selection, models: [fable] }, done);
    down(picker, 1);
    picker.handleInput('\r');
    type(picker, 'Fable');
    picker.handleInput(' '); // Remove
    picker.handleInput(' '); // Add once
    expect(picker.render(100).join('\n')).toContain('Members · 1 selected');
    picker.handleInput(' '); // Remove again
    picker.handleInput('\r'); // Keep choices
    picker.handleInput('\r'); // Apply
    expect(done).not.toHaveBeenCalled();
    expect(picker.render(100).join('\n')).toContain('Select at least one member');
    picker.handleInput('\x1b');
    expect(done).toHaveBeenCalledWith(null);
  });

  it('searches synthesizers across the full catalog without changing the members', () => {
    const h = harness();
    const done = vi.fn();
    const picker = new CouncilPicker(h.ctx, theme, selection, done);
    down(picker, 2);
    picker.handleInput('\r');
    type(picker, 'GPT 6 Astra'); // Spaces are search text in single-select mode
    expect(picker.render(120).join('\n')).toContain('GPT-6 Astra · openai-codex');
    expect(picker.render(120).join('\n')).not.toContain('Claude Fable');
    expectFits(picker);
    down(picker, 1); // Codex, not API
    picker.handleInput('\r');
    picker.handleInput('\r'); // Apply
    expect(done).toHaveBeenCalledWith({ selection: { ...selection, chairman: astra }, saveDefault: false });
  });

  it('keeps missing models visible and removable, and recognizes unique bare configured IDs', () => {
    const h = harness();
    const done = vi.fn();
    const picker = new CouncilPicker(
      h.ctx,
      theme,
      { ...selection, models: ['claude-fable-5-1', 'missing/model'] },
      done,
    );
    down(picker, 1);
    picker.handleInput('\r');
    expect(picker.render(120).join('\n')).toContain('[x] Claude Fable 5.1');
    type(picker, 'missing');
    expect(picker.render(120).join('\n')).toContain('[x] missing/model · unavailable or ambiguous');
    picker.handleInput(' ');
    picker.handleInput('\r');
    picker.handleInput('\r');
    expect(done).toHaveBeenCalledWith({ selection: { ...selection, models: [fable] }, saveDefault: false });
  });

  it('handles no search results without changing the selection', () => {
    const h = harness();
    const done = vi.fn();
    const picker = new CouncilPicker(h.ctx, theme, selection, done);
    down(picker, 1);
    picker.handleInput('\r');
    type(picker, 'no-such-model');
    expect(picker.render(80).join('\n')).toContain('No matching models');
    picker.handleInput(' ');
    picker.handleInput('\r');
    picker.handleInput('\r');
    expect(done).toHaveBeenCalledWith({ selection, saveDefault: false });
  });

  it('keeps global saving secondary and preserves default thinking', () => {
    const h = harness();
    const done = vi.fn();
    const defaults = { ...selection, memberThinking: null, chairmanThinking: null };
    const picker = new CouncilPicker(h.ctx, theme, defaults, done);
    expect(picker.render(120).join('\n')).toContain('default');
    down(picker, 5);
    picker.handleInput('\r');
    expect(done).toHaveBeenCalledWith({ selection: defaults, saveDefault: true });
  });
});
