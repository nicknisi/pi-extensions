import { createEventBus, type ExtensionAPI, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import statusline from './index.js';

vi.mock('./config.js', () => ({
  loadStatuslineConfig: () => ({ config: { hiddenStatuses: [] }, warnings: [] }),
  shouldShowStatus: () => true,
}));

afterEach(() => vi.unstubAllEnvs());

function setup() {
  vi.stubEnv('TMUX', '');
  const events = createEventBus();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const colors: Array<{ color: string; text: string }> = [];
  const renderRequested = vi.fn();
  let footer: { render(width: number): string[]; dispose(): void } | undefined;
  const theme = {
    fg: (color: string, text: string) => {
      colors.push({ color, text });
      return text;
    },
  } as Theme;
  const ctx = {
    mode: 'tui',
    hasUI: true,
    model: { id: 'test', name: 'Test model', provider: 'test', reasoning: false },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ tokens: 139000, percent: 13, contextWindow: 1048576 }),
    ui: {
      notify: vi.fn(),
      setFooter: (factory: Function) => {
        footer = factory({ requestRender: renderRequested }, theme, {
          onBranchChange: () => () => {},
          getGitBranch: () => undefined,
          getExtensionStatuses: () => new Map(),
        });
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  statusline(pi);
  return {
    events,
    colors,
    renderRequested,
    async fire(name: string) {
      for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
    },
    render() {
      colors.length = 0;
      const text = footer!.render(120).join('\n');
      const bar = colors.find((item) => /^[━╌]+$/.test(item.text));
      return { text, bar };
    },
    dispose() {
      footer?.dispose();
    },
  };
}

describe('self-compact context colors', () => {
  it('preserves the existing remaining-context meter and fallback colors', async () => {
    const h = setup();
    await h.fire('session_start');
    const { text, bar } = h.render();
    expect(text).toContain('87% ctx (139K)');
    expect(bar?.text).toHaveLength(20);
    expect(bar?.color).toBe('success');
    h.dispose();
  });

  it.each(['success', 'accent', 'warning', 'error', 'dim'])(
    'uses the published %s color without changing the meter',
    async (color) => {
      const h = setup();
      await h.fire('session_start');
      const baseline = h.render();
      h.events.emit('self-compact:context-color', color);
      const updated = h.render();
      expect(updated.text).toBe(baseline.text);
      expect(updated.bar?.color).toBe(color);
      expect(h.renderRequested).toHaveBeenCalled();
      h.dispose();
    },
  );

  it('announces footer ownership and answers late discovery without load-order dependence', async () => {
    const h = setup();
    const availability: unknown[] = [];
    h.events.on('statusline:context-bar', (value) => availability.push(value));
    await h.fire('session_start');
    expect(availability).toEqual([true]);
    h.events.emit('statusline:request-context-bar', undefined);
    expect(availability).toEqual([true, true]);
    h.dispose();
    expect(availability.at(-1)).toBe(false);
    await h.fire('session_shutdown');
    const count = availability.length;
    h.events.emit('statusline:request-context-bar', undefined);
    expect(availability).toHaveLength(count);
  });

  it('falls back when self-compact unloads or sends an invalid color', async () => {
    const h = setup();
    await h.fire('session_start');
    h.events.emit('self-compact:context-color', 'error');
    expect(h.render().bar?.color).toBe('error');
    h.events.emit('self-compact:context-color', undefined);
    expect(h.render().bar?.color).toBe('success');
    h.events.emit('self-compact:context-color', 'not-a-theme-color');
    expect(h.render().bar?.color).toBe('success');
    h.dispose();
  });
});
