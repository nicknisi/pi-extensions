import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import btw from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'btw-model-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  mkdirSync(join(dir, 'configs'));
  writeFileSync(join(dir, 'configs/btw.json'), JSON.stringify({ model: 'optional/org/model' }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it.each(['unavailable', 'rejects', 'usable'])('selects the btw model when preference %s', async (mode) => {
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  const preferred = { provider: 'optional', id: 'org/model' };
  const current = { provider: 'session', id: 'current' };
  const getAvailableOfType = vi.fn(async () => {
    if (mode === 'rejects') throw new Error('lookup failed');
    return mode === 'usable' ? [preferred] : [];
  });
  // A catalog entry is not proof of available credentials.
  const find = vi.fn(() => preferred);
  const getApiKeyAndHeaders = vi.fn(async () => ({ ok: false, error: 'stop after selection' }));
  const notify = vi.fn();
  const ctx = {
    model: current,
    modelRegistry: { find, getAvailableOfType, getApiKeyAndHeaders },
    sessionManager: { buildContextEntries: () => [] },
    ui: { notify },
  } as unknown as ExtensionContext;
  btw({
    on() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    getThinkingLevel: () => 'off',
    registerCommand(_name: string, spec: { handler: typeof command }) {
      command = spec.handler;
    },
  } as unknown as ExtensionAPI);
  await command('question', ctx);
  expect(getApiKeyAndHeaders).toHaveBeenLastCalledWith(mode === 'usable' ? preferred : current);
  ctx.model = { ...current, id: 'changed' } as ExtensionContext['model'];
  await command('question', ctx);
  expect(getApiKeyAndHeaders).toHaveBeenLastCalledWith(mode === 'usable' ? preferred : ctx.model);
  ctx.model = undefined;
  await command('question', ctx);
  if (mode !== 'usable') expect(notify).toHaveBeenLastCalledWith('btw: no current model available', 'error');
  expect(find).not.toHaveBeenCalled();
});
