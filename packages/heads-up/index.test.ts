import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  initTheme,
  SessionManager,
  type EntryRenderer,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { type Component, visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStore } from './config.js';
import headsUp from './index.js';

const NOTE = `learn: The agent skipped the migration test because it needs a live database.
tag: Heads up
explain:
**The migration was never tested**
The agent wrote the migration but did not run it.`;

const INSIGHT = `learn: Database transactions keep a failed migration from leaving partially applied schema changes.
tag: Insights
explain:
**Transactions make migration failures recoverable**
Wrapping the migration in a transaction rolls back earlier statements when a later one fails.`;

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Factory = (tui: unknown, theme: unknown, kb?: unknown, done?: (v: unknown) => void) => Component;

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

/** A registry with one available classifier answering `probability`, or failing when undefined. */
const withClassifier = (probability?: number) => ({
  getAvailableOfType: vi.fn(async () => [{ provider: 'typesafe', id: 'jev-latest' }]),
  classify: vi.fn(async () =>
    probability === undefined
      ? { stopReason: 'error', errorMessage: 'boom', answers: {} }
      : { stopReason: 'stop', answers: { q: { type: 'bool', probability } } },
  ),
});

function harness(reply = NOTE, registry: Record<string, unknown> = {}, sessionManager = SessionManager.inMemory()) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void>>();
  const sendUserMessage = vi.fn();
  sessionManager.appendMessage({ role: 'user', content: 'do the thing', timestamp: Date.now() });
  const appendEntry = vi.fn((type: string, data: unknown) => sessionManager.appendCustomEntry(type, data));
  const renderers = new Map<string, EntryRenderer>();
  const notify = vi.fn();
  let widget: Factory | undefined;
  let panelKeys: string[] = [];
  const complete = vi.fn(
    async (..._args: Parameters<ExtensionContext['modelRegistry']['complete']>) =>
      ({
        content: [{ type: 'text', text: reply }],
        stopReason: 'stop',
        usage: { cost: { total: 0.12 } },
      }) as unknown as AssistantMessage,
  );

  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, c: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      commands.set(name, c.handler),
    registerShortcut: (key: string, s: { handler: (ctx: ExtensionContext) => Promise<void> }) =>
      shortcuts.set(key, s.handler),
    sendUserMessage,
    appendEntry,
    registerEntryRenderer: (name: string, renderer: EntryRenderer) => renderers.set(name, renderer),
  } as unknown as ExtensionAPI;

  const ctx = {
    mode: 'tui',
    model: { provider: 'p', id: 'm' },
    isIdle: () => true,
    modelRegistry: { complete, find: () => undefined, ...registry },
    sessionManager,
    ui: {
      notify,
      setWidget: (_key: string, content: Factory | undefined) => {
        widget = content;
      },
      custom: (factory: Factory) =>
        new Promise((resolve) => {
          const panel = factory({ requestRender() {} }, theme, {}, resolve);
          for (const key of panelKeys) panel.handleInput?.(key);
        }),
    },
  } as unknown as ExtensionContext;

  headsUp(pi);
  const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const band = () => widget?.({}, theme).render(200).join('\n');
  const press = async (...keys: string[]) => {
    panelKeys = keys;
    await shortcuts.get('alt+h')!(ctx);
  };
  const longTurn = async (tools = 8) => {
    await fire('before_agent_start');
    for (let i = 0; i < tools; i += 1) await fire('tool_execution_start');
    await fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] });
  };
  return {
    appendEntry,
    band,
    commands,
    complete,
    ctx,
    fire,
    longTurn,
    notify,
    press,
    renderers,
    sendUserMessage,
    sessionManager,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heads-up-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('heads-up', () => {
  it('a long turn ends in one check and a note above the editor', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(h.band()).toContain('migration test');
    expect(readStore().offered).toEqual(['The agent skipped the migration test because it needs a live database.']);
    expect(readStore().events.map((e) => e.kind)).toEqual(['proposed']);
    expect(readStore().events[0]?.cost).toBe(0.12);
  });

  it('posts an Insight inline without occupying the heads-up widget or sending a model message', async () => {
    const h = harness(INSIGHT, withClassifier(0.7));
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.appendEntry).toHaveBeenCalledExactlyOnceWith(
      'heads-up-insight',
      '**Transactions make migration failures recoverable**\n\nWrapping the migration in a transaction rolls back earlier statements when a later one fails.',
    );
    expect(h.band()).toBeUndefined();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    expect(h.ctx.sessionManager.getBranch()).toContainEqual(
      expect.objectContaining({ type: 'custom', customType: 'heads-up-insight' }),
    );
    expect(h.sessionManager.buildSessionContext().messages).toEqual([
      { role: 'user', content: 'do the thing', timestamp: expect.any(Number) },
    ]);
    expect(readStore().offered).toEqual([
      'Database transactions keep a failed migration from leaving partially applied schema changes.',
    ]);
    expect(readStore().events).toMatchObject([{ kind: 'insight', score: 0.7, cost: 0.12 }]);

    await h.fire('input', { source: 'interactive', text: 'next' });
    expect(readStore().events.map((e) => e.kind)).toEqual(['insight']);
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.appendEntry).toHaveBeenCalledTimes(2);
    expect(h.complete.mock.calls[1]?.[1].messages[0]?.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('Already offered recently; skip these') }),
    ]);
  });

  it.each(['session_shutdown', 'session_tree'])('does not post a stale Insight after %s', async (event) => {
    const h = harness(INSIGHT);
    let finish!: (reply: AssistantMessage) => void;
    h.complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);
    if (event === 'session_tree') {
      h.sessionManager.resetLeaf();
      h.sessionManager.appendMessage({ role: 'user', content: 'a different branch', timestamp: Date.now() });
    }
    await h.fire(event);
    finish({ content: [{ type: 'text', text: INSIGHT }], stopReason: 'stop' } as AssistantMessage);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(readStore().events).toEqual([]);
    expect(readStore().offered).toEqual([]);
  });

  it('a manual Insight does not report that nothing was found or open a panel', async () => {
    const h = harness(INSIGHT);
    await h.commands.get('heads-up')!('check', h.ctx);
    expect(h.appendEntry).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalledWith('heads-up: nothing worth flagging', 'info');
    await h.press();
    expect(h.notify).toHaveBeenLastCalledWith('heads-up: nothing to show', 'info');
  });

  it('keeps Insights when a saved session is reopened without adding model context', async () => {
    const h = harness(INSIGHT, {}, SessionManager.create(dir, join(dir, 'sessions')));
    await h.commands.get('heads-up')!('check', h.ctx);
    const reopened = SessionManager.open(h.sessionManager.getSessionFile()!);
    expect(reopened.getBranch()).toContainEqual(
      expect.objectContaining({
        type: 'custom',
        customType: 'heads-up-insight',
        data: expect.stringContaining('Transactions make migration failures recoverable'),
      }),
    );
    expect(reopened.buildSessionContext().messages).toEqual(h.sessionManager.buildSessionContext().messages);
    expect(reopened.buildSessionContext().messages).toHaveLength(1);
  });

  it('renders a persisted Insight with its full explanation at narrow widths', () => {
    initTheme('dark');
    const h = harness();
    const renderer = h.renderers.get('heads-up-insight')!;
    const entry = {
      type: 'custom' as const,
      customType: 'heads-up-insight',
      id: 'insight',
      parentId: null,
      timestamp: new Date().toISOString(),
      data: '**Recoverable migrations**\n\nRoll back partial schema changes.',
    };
    const component = renderer(entry, { expanded: false }, theme as unknown as Theme)!;
    const lines = component.render(30);
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
    const text = stripVTControlCharacters(lines.join('\n'));
    expect(text).toContain('✦ Insights');
    expect(text).toContain('Recoverable migrations');
    expect(text).toContain('Roll back partial schema');
    expect(text).not.toContain('alt+h');
    component.invalidate();
    expect(stripVTControlCharacters(component.render(80).join('\n'))).toContain('Roll back partial schema changes.');
    expect(renderer({ ...entry, data: undefined }, { expanded: false }, theme as unknown as Theme)).toBeUndefined();
  });

  it.each(['unconfigured', 'missing', 'lookup fails'])('falls back to the session model when %s', async (reason) => {
    mkdirSync(join(dir, 'configs'), { recursive: true });
    writeFileSync(join(dir, 'configs', 'heads-up.json'), JSON.stringify({ model: 'anthropic/claude-haiku-4-5' }));
    const configured = { provider: 'anthropic', id: 'claude-haiku-4-5' };
    const h = harness(NOTE, {
      find: () => (reason === 'missing' ? undefined : configured),
      getAvailableOfType: vi.fn(async () => {
        if (reason === 'lookup fails') throw new Error('credential lookup failed');
        return [];
      }),
    });
    h.complete.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === configured) throw new Error('Provider is not configured: anthropic');
      return { content: [{ type: 'text', text: NOTE }], stopReason: 'stop' } as AssistantMessage;
    });
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining('check failed:'), 'warning');
    expect(h.complete).toHaveBeenCalledWith(h.ctx.model, expect.anything(), expect.anything());
    expect(h.band()).toContain('migration test');

    await h.press('0');
    const current = { ...h.ctx.model!, provider: 'new-session-provider' };
    h.ctx.model = current;
    await h.commands.get('heads-up')!('check', h.ctx);
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.complete).toHaveBeenLastCalledWith(current, expect.anything(), expect.anything());
    expect(h.notify.mock.calls.filter(([message]) => message.includes('using the session model'))).toHaveLength(1);
  });

  it('uses the configured model when its provider is available', async () => {
    mkdirSync(join(dir, 'configs'), { recursive: true });
    writeFileSync(join(dir, 'configs', 'heads-up.json'), JSON.stringify({ model: 'anthropic/claude-haiku-4-5' }));
    const configured = { provider: 'anthropic', id: 'claude-haiku-4-5' };
    const getAvailableOfType = vi.fn(async () => [configured]);
    const h = harness(NOTE, { getAvailableOfType });
    await h.commands.get('heads-up')!('check', h.ctx);

    expect(getAvailableOfType).toHaveBeenCalledWith('chat', 'anthropic', { signal: expect.any(AbortSignal) });
    expect(h.complete).toHaveBeenCalledWith(configured, expect.anything(), expect.anything());
    expect(h.band()).toContain('migration test');
    expect(h.notify).not.toHaveBeenCalledWith(expect.anything(), 'warning');
  });

  it('reports a failure when neither a configured nor a session model is available', async () => {
    const h = harness();
    h.ctx.model = undefined;
    await h.commands.get('heads-up')!('check', h.ctx);

    expect(h.complete).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith('heads-up: check failed: no model available', 'warning');
  });

  it('a check that finds nothing is logged with its cost', async () => {
    const h = harness('learn: none');
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readStore().events).toEqual([expect.objectContaining({ kind: 'none', cost: 0.12 })]);
    await h.commands.get('heads-up')!('', h.ctx);
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('Logged check cost: $0.12.'), 'info');
  });

  it('a short turn makes no check', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.longTurn(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('an aborted turn makes no check', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.fire('before_agent_start');
    for (let i = 0; i < 8; i += 1) await h.fire('tool_execution_start');
    await h.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('a running turn gets one mid-turn check once it counts as long', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.fire('before_agent_start');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('respects the cooldown between checks', async () => {
    const h = harness('learn: none');
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it('Knew this records the topic and clears the note', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    await h.press('3');
    expect(h.band()).toBeUndefined();
    expect(readStore().known).toEqual(['The agent skipped the migration test because it needs a live database.']);
    expect(readStore().events.map((e) => e.kind)).toEqual(['proposed', 'known']);
  });

  it('Make a page clears the note and asks the main agent', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    await h.press('2');
    expect(h.band()).toBeUndefined();
    expect(h.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('publish it as an artifact'), undefined);
  });

  it('esc keeps the note', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    await h.press('\x1b');
    expect(h.band()).toContain('migration test');
  });

  it('submitting a prompt clears an unanswered note', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    await h.fire('input', { source: 'interactive', text: 'next' });
    expect(h.band()).toBeUndefined();
    expect(readStore().events.map((e) => e.kind)).toEqual(['proposed', 'ignored_submit']);
  });

  it('the gate in shadow mode scores the check but still runs it', async () => {
    const registry = withClassifier(0.2);
    const h = harness(NOTE, registry);
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(registry.classify).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(readStore().events).toMatchObject([{ kind: 'proposed', score: 0.2 }]);
  });

  it('the gate logs a scored check that found nothing', async () => {
    const h = harness('learn: none', withClassifier(0.7));
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readStore().events).toMatchObject([{ kind: 'none', score: 0.7 }]);
  });

  it('an enforced gate skips checks below the threshold', async () => {
    mkdirSync(join(dir, 'configs'), { recursive: true });
    writeFileSync(join(dir, 'configs', 'heads-up.json'), JSON.stringify({ gateEnforce: true, gateThreshold: 0.5 }));
    const h = harness(NOTE, withClassifier(0.2));
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.complete).not.toHaveBeenCalled();
    expect(h.band()).toBeUndefined();
    expect(readStore().events).toMatchObject([{ kind: 'gated', score: 0.2 }]);
  });

  it('an enforced gate that fails lets the check run', async () => {
    mkdirSync(join(dir, 'configs'), { recursive: true });
    writeFileSync(join(dir, 'configs', 'heads-up.json'), JSON.stringify({ gateEnforce: true }));
    const h = harness(NOTE, withClassifier(undefined));
    await h.fire('session_start');
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(readStore().events).toEqual([expect.objectContaining({ kind: 'proposed' })]);
    expect(readStore().events[0]).not.toHaveProperty('score');
  });

  it('/heads-up off stops checks', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.commands.get('heads-up')!('off', h.ctx);
    await h.longTurn();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.complete).not.toHaveBeenCalled();
    expect(readStore().disabled).toBe(true);
  });
});
