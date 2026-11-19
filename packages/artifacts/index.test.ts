import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./utils.js', async (original) => ({
  ...(await original<typeof import('./utils.js')>()),
  openInBrowser: vi.fn(),
}));

const { default: artifacts } = await import('./index.js');
const { ensureServer, stopServer } = await import('./server.js');
const { writeArtifact } = await import('./utils.js');

type Handler = (event: unknown, ctx?: unknown) => unknown;
const cwd = process.cwd();
let temp: string;
let handlers: Map<string, Handler[]>;
let tool: { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'artifact-index-'));
  process.chdir(temp);
  handlers = new Map();
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    events: { on: () => () => {}, emit: () => {} },
    registerTool: (t: typeof tool) => (tool = t),
    registerCommand: () => {},
    sendUserMessage: () => {},
  };
  artifacts(pi as never);
});
afterEach(() => {
  for (const h of handlers.get('session_shutdown') ?? []) h({});
  stopServer();
  process.chdir(cwd);
  rmSync(temp, { recursive: true, force: true });
});

const toolCall = (url: string) =>
  handlers.get('tool_call')![0]!({ toolName: 'navigate_browser', input: { url } }) as { block?: boolean } | undefined;

it('blocks test-browser navigation to every artifact origin, including <label>.localhost', async () => {
  const port = await ensureServer();
  expect(toolCall(`http://127.0.0.1:${port}/x.html`)?.block).toBe(true);
  expect(toolCall(`http://localhost:${port}/x.html`)?.block).toBe(true);
  expect(toolCall(`http://0123456789abcdef.localhost:${port}/c/x.html`)?.block).toBe(true);
  expect(toolCall(`http://example.com:${port}/`)).toBeUndefined();
  expect(toolCall(`http://localhost:${port + 1}/`)).toBeUndefined();
});

it('open reports the stored kind, not a markdown default', async () => {
  writeArtifact('page', '<!DOCTYPE html><html><head><title>Page</title></head><body></body></html>');
  const ctx = { ui: { setStatus: () => {}, theme: { fg: (_: string, s: string) => s } } };
  const res = await tool.execute('id', { action: 'open', title: 'Page' }, undefined, undefined, ctx);
  expect(res.details.kind).toBe('html');
});
