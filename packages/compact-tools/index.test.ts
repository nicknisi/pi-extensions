import {
  createBashToolDefinition,
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  Text,
  visibleWidth,
  type TUI,
} from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import compactTools from './index.js';

type Handler = (event: unknown, ctx: ExtensionContext) => void;
const shutdowns: Array<() => void> = [];
const originalKeybindings = getKeybindings();
initTheme('dark', false);
afterEach(() => {
  for (const shutdown of shutdowns.reverse()) shutdown();
  shutdowns.length = 0;
  setKeybindings(originalKeybindings);
});

function install(mode: ExtensionContext['mode'] = 'tui') {
  setKeybindings(new KeybindingsManager({ 'app.tools.expand': { defaultKeys: 'ctrl+o' } }));
  const handlers = new Map<string, Handler>();
  const ctx = {
    mode,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bg: vi.fn((_color: string, text: string) => text),
      },
      notify: vi.fn(),
      setToolsExpanded: vi.fn(),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionContext;
  compactTools({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const start = () => handlers.get('session_start')!({}, ctx);
  const shutdown = () => handlers.get('session_shutdown')!({}, ctx);
  shutdowns.push(shutdown);
  start();
  return { start, shutdown, handlers, ctx };
}

type Definition = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

function row(name = 'bash', definition?: Definition) {
  return new ToolExecutionComponent(
    name,
    'call-1',
    { command: 'printf "first\\nsecond\\nthird"' },
    {},
    definition,
    { requestRender: vi.fn() } as unknown as TUI,
    process.cwd(),
  );
}

const result = {
  content: [{ type: 'text', text: '\nfirst\nsecond\nthird' }],
  details: { untouched: true },
  isError: false,
};
const plain = (component: ToolExecutionComponent, width = 80) =>
  component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
const click = (component: ToolExecutionComponent, type = 'click', button = 'left', y = 1) =>
  (component as unknown as { handleMouse(event: { type: string; button: string; y: number }): unknown }).handleMouse({
    type,
    button,
    y,
  });

it('compacts existing and future rows, preserves results, and restores native expanded rendering', () => {
  const existing = row('bash', createBashToolDefinition(process.cwd()));
  existing.updateResult(result);
  existing.setExpanded(true);
  const expanded = existing.render(80);
  existing.setExpanded(false);
  const { ctx, handlers } = install();

  expect([...handlers.keys()]).toEqual(['session_start', 'session_shutdown']);
  expect(ctx.ui.setToolsExpanded).toHaveBeenCalledWith(false);
  expect(ctx.ui.setStatus).toHaveBeenCalledWith('compact-tools', undefined);
  const before = structuredClone(result);
  for (const component of [existing, row('mcp__test__query')]) {
    component.updateResult(result);
    expect(plain(component)).toEqual(['', expect.stringContaining('▸ '), '  first … [ctrl+o]']);
    component.setExpanded(true);
    expect(plain(component).join('\n')).toContain('third');
    component.setExpanded(false);
    expect(plain(component)).toHaveLength(3);
  }
  existing.setExpanded(true);
  expect(existing.render(80)).toEqual(expanded);
  expect(result).toEqual(before);
});

it('restores custom self-shell renderers and allows per-row clicks without sending input to hidden children', () => {
  const definition: Definition = {
    ...createBashToolDefinition(process.cwd()),
    name: 'custom',
    renderShell: 'self',
    renderCall: () => new Text('Original header\nExtra header', 0, 0),
    renderResult: () => new Text('Original result\nOriginal detail', 0, 0),
  };
  const component = row('custom', definition);
  component.updateResult(result);
  component.setExpanded(true);
  const expanded = component.render(80);
  component.setExpanded(false);
  install();
  expect(plain(component)).toHaveLength(3);
  expect(plain(component)[1]).toBe('▸ Original header');
  expect(plain(component)[2]).toBe('  Original result … [ctrl+o]');
  expect(click(component, 'click', 'right')).toBeUndefined();
  expect(click(component, 'wheel')).toBeUndefined();
  expect(click(component, 'drag')).toBeUndefined();
  expect(click(component, 'click', 'left', 0)).toBeUndefined();
  expect(plain(component)).toHaveLength(3);
  expect(click(component)).toEqual({ handled: true });
  expect(component.render(80)).toEqual(expanded);
  component.setExpanded(false);
  expect(plain(component)).toHaveLength(3);
});

it('bounds pending, streaming, error, empty, and image displays, including narrow Unicode output', () => {
  install();
  const component = row('custom');
  expect(plain(component)).toHaveLength(2);
  expect(click(component)).toBeUndefined();
  component.updateResult({ content: [], isError: false }, true);
  expect(plain(component)[2]).toContain('Running');
  component.updateResult({ content: [], isError: false });
  expect(plain(component)[2]).toContain('Done');
  component.updateResult({
    content: [
      { type: 'text', text: '\x1b]52;c;ZXZpbA==\x07\x1b[31m失敗\x1b[0m\tmessage\nMore detail' },
      { type: 'image' },
    ],
    isError: true,
  });
  expect(plain(component)[2]).toContain('Error: 失敗 message … [1 image]');
  expect(plain(component).join('\n')).not.toContain('52;c;');
  for (const width of [0, 1, 2, 5, 12, 40, 80]) {
    expect(component.render(width)).toHaveLength(3);
    expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  }
});

it('fills both compact lines with the native outcome background and never dumps JSON arguments', () => {
  const { ctx } = install();
  const component = row('custom');
  component.updateArgs({ path: 'src/index.ts', content: 'private payload', extra: { nested: true } });
  expect(plain(component)[1]).toBe('▸ custom src/index.ts');
  for (const [isPartial, isError, background] of [
    [true, false, 'toolPendingBg'],
    [false, false, 'toolSuccessBg'],
    [false, true, 'toolErrorBg'],
  ] as const) {
    component.updateResult({ ...result, isError }, isPartial);
    vi.mocked(ctx.ui.theme.bg).mockClear();
    const lines = component.render(80);
    expect(lines.slice(1).map(visibleWidth)).toEqual([80, 80]);
    expect(ctx.ui.theme.bg).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctx.ui.theme.bg).mock.calls.every(([color]) => color === background)).toBe(true);
    expect(lines.join('\n')).not.toContain('private payload');
    expect(lines.join('\n')).not.toContain('{');
  }
});

it('summarizes JSON-only results instead of showing braces or serialized payloads', () => {
  install();
  const component = row('mcp__query');
  for (const [text, preview] of [
    ['{"ok":true,"items":[1,2]}', 'Structured result with 2 fields'],
    ['[{"id":1},{"id":2}]', '2 result items'],
    ['{\n  "partial":', 'Structured output …'],
  ]) {
    component.updateResult({ content: [{ type: 'text', text: text! }], isError: false });
    expect(plain(component)[2]).toBe(`  ${preview} [ctrl+o]`);
    component.setExpanded(true);
    expect(plain(component).join('\n')).toContain(text!.split('\n')[0]);
    component.setExpanded(false);
  }
});

it('restores prototype methods on shutdown and does not stack wrappers on repeated starts', () => {
  const originalRender = ToolExecutionComponent.prototype.render;
  const component = row();
  component.updateResult(result);
  const originalLines = component.render(80);
  const extension = install();
  extension.start();
  expect(plain(component)).toHaveLength(3);
  extension.shutdown();
  expect(ToolExecutionComponent.prototype.render).toBe(originalRender);
  expect(component.render(80)).toEqual(originalLines);
  extension.start();
  expect(plain(component)).toHaveLength(3);
});

it('leaves print, JSON, and RPC runtimes untouched', () => {
  const originalRender = ToolExecutionComponent.prototype.render;
  for (const mode of ['print', 'json', 'rpc'] as const) {
    const { ctx } = install(mode);
    expect(ToolExecutionComponent.prototype.render).toBe(originalRender);
    expect(ctx.ui.setToolsExpanded).not.toHaveBeenCalled();
  }
});
