import {
  createBashToolDefinition,
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolRendererResolver,
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
const originalKeybindings = getKeybindings();
initTheme('dark', false);
afterEach(() => {
  resolver = undefined;
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
  compactTools({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerToolRenderer: (fn: ToolRendererResolver) => (resolver = fn),
  } as unknown as ExtensionAPI);
  handlers.get('session_start')!({}, ctx);
  return { handlers, ctx };
}

let resolver: ToolRendererResolver | undefined;

type Definition = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

function row(name = 'bash', definition?: Definition) {
  return new ToolExecutionComponent(
    name,
    'call-1',
    { command: 'printf "first\\nsecond\\nthird"' },
    {},
    (resolver ? resolver(name, () => definition) : definition) as Definition,
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

it('compacts built-in and unknown rows, preserves results, and matches native expanded rendering', () => {
  const native = row('bash', createBashToolDefinition(process.cwd()));
  native.updateResult(result);
  native.setExpanded(true);
  const expanded = native.render(80);
  native.setExpanded(false);
  const pending = row('bash', createBashToolDefinition(process.cwd()));
  pending.setExpanded(true);
  const expandedPending = pending.render(80);
  const { ctx, handlers } = install();

  expect([...handlers.keys()]).toEqual(['session_start']);
  expect(ctx.ui.setToolsExpanded).toHaveBeenCalledWith(false);
  expect(ctx.ui.setStatus).toHaveBeenCalledWith('compact-tools', undefined);
  const before = structuredClone(result);
  const bash = row('bash', createBashToolDefinition(process.cwd()));
  bash.setExpanded(true);
  expect(bash.render(80)).toEqual(expandedPending);
  bash.setExpanded(false);
  for (const component of [bash, row('mcp__test__query')]) {
    component.updateResult(result);
    expect(plain(component)).toEqual(['', expect.stringContaining('▸ '), '  first … [ctrl+o]']);
    component.setExpanded(true);
    expect(plain(component).join('\n')).toContain('third');
    component.setExpanded(false);
    expect(plain(component)).toHaveLength(3);
  }
  bash.setExpanded(true);
  expect(bash.render(80)).toEqual(expanded);
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
  const native = row('custom', definition);
  native.updateResult(result);
  native.setExpanded(true);
  const expanded = native.render(80);
  install();
  const component = row('custom', definition);
  component.updateResult(result);
  expect(plain(component)).toHaveLength(3);
  expect(plain(component)[1]).toBe('▸ Original header');
  expect(plain(component)[2]).toBe('  Original result … [ctrl+o]');
  expect(click(component, 'click', 'right')).toBeUndefined();
  expect(click(component, 'wheel')).toBeUndefined();
  expect(click(component, 'drag')).toBeUndefined();
  expect(plain(component)).toHaveLength(3);
  expect(click(component)).toMatchObject({ handled: true });
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
  install();
  const opener = (color: 'toolPendingBg' | 'toolSuccessBg' | 'toolErrorBg') => {
    let open = '';
    const probe: Definition = {
      ...createBashToolDefinition(process.cwd()),
      renderShell: 'self',
      renderCall: (_args, theme) => new Text((open = theme.bg(color, '\0').split('\0')[0]!), 0, 0),
      renderResult: () => new Text('', 0, 0),
    };
    row('probe', probe).render(10);
    return open;
  };
  const component = row('custom');
  component.updateArgs({ path: 'src/index.ts', content: 'private payload', extra: { nested: true } });
  expect(plain(component)[1]).toBe('▸ custom src/index.ts');
  for (const [isPartial, isError, background] of [
    [true, false, 'toolPendingBg'],
    [false, false, 'toolSuccessBg'],
    [false, true, 'toolErrorBg'],
  ] as const) {
    component.updateResult({ ...result, isError }, isPartial);
    const lines = component.render(80);
    expect(lines.slice(1).map(visibleWidth)).toEqual([80, 80]);
    expect(lines.slice(1).every((line) => line.startsWith(opener(background)))).toBe(true);
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

it('does not touch the expansion state of print, JSON, and RPC runtimes', () => {
  for (const mode of ['print', 'json', 'rpc'] as const) {
    const { ctx } = install(mode);
    expect(ctx.ui.setToolsExpanded).not.toHaveBeenCalled();
  }
});
