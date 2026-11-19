import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type Component } from '@earendil-works/pi-tui';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let agentDir: string;
beforeEach(() => {
  agentDir = fs.mkdtempSync(join(tmpdir(), 'pi-header-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

const load = () => import('./index.js');

describe('gif decoder', () => {
  it('expands RLE tokens to the declared width for every frame set', async () => {
    const { GIFS, SIZES } = await load();
    for (const mode of ['blink', 'waiting'] as const) {
      for (const size of SIZES) {
        const gif = GIFS[mode][size];
        expect(gif.count).toBeGreaterThan(0);
        const width = gif.width();
        expect(width).toBeGreaterThan(0);
        for (let i = 0; i < gif.count; i++) {
          for (const line of gif.frame(i)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('decodes run-length tokens and blank cells', async () => {
    const { makeGifDecoder } = await load();
    const gif = makeGifDecoder({
      COLORS: [
        [0, 0, 0],
        [255, 0, 0],
      ],
      CELLS: [
        [0, 0],
        [1, 0],
      ],
      FRAMES: [{ delay: 100, lines: [['1*3', '0', '1']] }],
    });
    expect(gif.width()).toBe(5);
    expect(gif.frame(0)[0]).toBe(`${'\x1b[38;2;255;0;0m▀\x1b[0m'.repeat(3)} \x1b[38;2;255;0;0m▀\x1b[0m`);
  });
});

describe('layoutRows', () => {
  const info = ['pi v1 · some-provider/a-very-long-model-identifier', '~/a/very/long/path  ·  branch', 'quote'];
  it.each([10, 40, 60, 80, 120])('never exceeds width %i', async (width) => {
    const { layoutRows } = await load();
    const art = Array.from({ length: 12 }, () => 'x'.repeat(46));
    for (const row of layoutRows(art, 46, info, width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  });

  it('drops the art when too narrow for art + info', async () => {
    const { layoutRows } = await load();
    const rows = layoutRows(['xxxx'], 4, ['info'], 20);
    expect(rows).toEqual(['', '  info']);
  });

  it('keeps art beside info when wide enough', async () => {
    const { layoutRows } = await load();
    expect(layoutRows(['xx', 'xx', 'xx'], 2, ['info'], 80)).toEqual(['', '  xx', '  xx   info', '  xx']);
  });
});

function harness() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  let header: (Component & { dispose?(): void }) | undefined;
  const notify = vi.fn();
  const setHeader = vi.fn((factory: ((tui: unknown, theme: unknown) => Component) | undefined) => {
    header?.dispose?.();
    header = factory?.(tui, theme);
  });
  const tui = { requestRender: vi.fn() };
  const theme = {
    fg: (_c: string, s: string) => s,
    bold: (s: string) => s,
    italic: (s: string) => s,
    getFgAnsi: () => '\x1b[38;5;1m',
  };
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
    registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, cmd),
    exec: vi.fn(async () => ({ stdout: 'main\n', stderr: '', code: 0, killed: false, truncated: false })),
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'tui',
    cwd: '/tmp/some/project',
    model: { provider: 'anthropic', id: 'claude-something-with-a-very-long-identifier' },
    sessionManager: { getBranch: () => [] },
    ui: { setHeader, notify },
  };
  return { handlers, commands, pi, ctx, setHeader, notify, getHeader: () => header };
}

describe('extension', () => {
  it('renders within narrow widths', async () => {
    vi.useFakeTimers();
    const { default: ext } = await load();
    const h = harness();
    ext(h.pi);
    h.handlers.get('session_start')!({}, h.ctx);
    for (const width of [20, 40, 60, 80]) {
      for (const row of h.getHeader()!.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
    h.getHeader()?.dispose?.();
  });

  it('dispose stops the animation and keeps another header intact', async () => {
    vi.useFakeTimers();
    const { default: ext } = await load();
    const h = harness();
    ext(h.pi);
    h.handlers.get('session_start')!({}, h.ctx);
    expect(vi.getTimerCount()).toBe(1);
    // Another extension replaces the header.
    h.ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
    expect(vi.getTimerCount()).toBe(0);
    h.setHeader.mockClear();
    h.handlers.get('before_agent_start')!({}, h.ctx);
    expect(h.setHeader).not.toHaveBeenCalled();
  });

  it('re-showing the dashboard keeps it active', async () => {
    vi.useFakeTimers();
    const { default: ext } = await load();
    const h = harness();
    ext(h.pi);
    h.handlers.get('session_start')!({}, h.ctx);
    await h.commands.get('nicknisi-header')!.handler('', h.ctx);
    expect(vi.getTimerCount()).toBe(1);
    h.setHeader.mockClear();
    h.handlers.get('before_agent_start')!({}, h.ctx);
    expect(h.setHeader).toHaveBeenCalledWith(undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an unknown size without changing it', async () => {
    const { default: ext } = await load();
    const h = harness();
    ext(h.pi);
    await h.commands.get('nicknisi-header-size')!.handler('huge', h.ctx);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('unknown size'), 'error');
    expect(fs.existsSync(join(agentDir, 'nicknisi-header.json'))).toBe(false);
    await h.commands.get('nicknisi-header-size')!.handler('small', h.ctx);
    expect(JSON.parse(fs.readFileSync(join(agentDir, 'nicknisi-header.json'), 'utf8'))).toEqual({ size: 'small' });
  });

  it('ignores an invalid size in the config file', async () => {
    fs.writeFileSync(join(agentDir, 'nicknisi-header.json'), JSON.stringify({ size: 'huge' }));
    const { default: ext } = await load();
    const h = harness();
    ext(h.pi);
    await h.commands.get('nicknisi-header-size')!.handler('', h.ctx);
    // Invalid size is treated as the default (medium), so cycling goes to large.
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('size: large'), 'info');
  });
});
