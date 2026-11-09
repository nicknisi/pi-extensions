import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_API_KEY_COMMAND, type PipesConfig } from './core.js';
import { createPipesExtension, type PipesDeps } from './index.js';

type ToolResult = { content: { text: string }[]; isError?: boolean; details: { savedTo?: string } };
type Tool = { execute: (...args: unknown[]) => Promise<ToolResult> };

const config: PipesConfig = {
  userId: 'user_1',
  apiKeyCommand: DEFAULT_API_KEY_COMMAND,
  baseUrl: 'https://api.example.test',
  maxInlineChars: 200,
  connectTimeoutMs: 1000,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(responses: Array<{ status: number; body: unknown }>) {
  const outputDir = mkdtempSync(join(tmpdir(), 'pipes-out-'));
  dirs.push(outputDir);
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift() ?? { status: 500, body: 'no more responses' };
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status });
  });
  const deps: PipesDeps = {
    loadConfig: () => config,
    resolveApiKey: async () => 'sk_test',
    fetch: fetchImpl as unknown as typeof fetch,
    openUrl: vi.fn(),
    outputDir,
  };
  const tools = new Map<string, Tool>();
  createPipesExtension(deps)({
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: () => {},
  } as unknown as ExtensionAPI);
  const ui = { confirm: vi.fn(async () => false), notify: vi.fn(), setStatus: vi.fn() };
  const run = (params: Record<string, unknown>, hasUI = true) =>
    tools.get('pipes')!.execute('id', params, undefined, undefined, { hasUI, ui });
  return { run, ui, deps, fetchImpl };
}

describe('pipes tool', () => {
  it('returns small JSON responses inline, pretty-printed', async () => {
    const { run } = setup([{ status: 200, body: { title: 'Sheet' } }]);
    const result = await run({ provider: 'google-sheets', path: '/v4/spreadsheets/abc' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{\n  "title": "Sheet"\n}');
  });

  it('saves oversized responses to a file and returns a preview', async () => {
    const big = { values: Array.from({ length: 50 }, (_, i) => [`row ${i}`, 'x'.repeat(20)]) };
    const { run } = setup([{ status: 200, body: big }]);
    const result = await run({ provider: 'google-sheets', path: '/v4/spreadsheets/abc/values/Tab' });
    expect(result.details.savedTo).toBeDefined();
    expect(JSON.parse(readFileSync(result.details.savedTo!, 'utf8'))).toEqual(big);
    expect(result.content[0]!.text).toContain('saved to');
  });

  it('asks before a write and stops when the user declines', async () => {
    const { run, ui, fetchImpl } = setup([]);
    const result = await run({ provider: 'github', path: '/user/repos', method: 'POST', body: { name: 'x' } });
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('declined');
  });

  it('refuses writes when there is no UI to approve them', async () => {
    const { run, fetchImpl } = setup([]);
    const result = await run({ provider: 'github', path: '/user/repos', method: 'DELETE' }, false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.content[0]!.text).toContain('approval');
  });

  it('signs the user in on a relay 402, waits for the connection, and retries', async () => {
    const { run, deps } = setup([
      { status: 402, body: { code: 'relay_authorization_required', authorization_url: 'https://auth.example/x' } },
      { status: 200, body: { state: 'connected', scopes: [] } },
      { status: 200, body: { ok: true } },
    ]);
    const result = await run({ provider: 'google-sheets', path: '/v4/spreadsheets/abc' });
    expect(deps.openUrl).toHaveBeenCalledWith('https://auth.example/x', config);
    expect(result.content[0]!.text).toContain('"ok": true');
  });

  it('explains a provider that Relay does not serve', async () => {
    const { run } = setup([
      { status: 404, body: { code: 'relay_provider_not_found', message: 'No relay provider found' } },
    ]);
    const result = await run({ provider: 'google-sheets', path: '/drive/v3/files' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('google-drive');
  });
});
