import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import answer from './index.js';

vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...(await original<typeof import('@earendil-works/pi-coding-agent')>()),
  BorderedLoader: class {
    signal = new AbortController().signal;
  },
}));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'answer-model-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  mkdirSync(join(dir, 'configs'));
  writeFileSync(
    join(dir, 'configs/answer.json'),
    JSON.stringify({ extractionModels: ['optional/org/model', 'second/model'] }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it.each(['unavailable', 'rejects', 'usable'])('selects extraction model when preference %s', async (mode) => {
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  const preferred = { provider: 'optional', id: 'org/model' };
  const current = { provider: 'session', id: 'current' };
  const getAvailableOfType = vi.fn(async () => {
    if (mode === 'rejects') throw new Error('lookup failed');
    return mode === 'usable' ? [preferred] : [];
  });
  const complete = vi
    .fn<ExtensionContext['modelRegistry']['complete']>()
    .mockResolvedValue({ content: [{ type: 'text', text: '{"questions":[]}' }] } as never);
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    model: current,
    modelRegistry: {
      find: () => preferred,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      getAvailableOfType,
      complete,
    },
    sessionManager: {
      getBranch: () => [
        {
          type: 'message',
          message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Which database?' }] },
        },
      ],
    },
    ui: {
      notify,
      setStatus() {},
      custom: (factory: (...args: unknown[]) => unknown) =>
        new Promise((resolve) => {
          factory({}, {}, {}, resolve);
        }),
    },
  } as unknown as ExtensionContext;
  answer({
    on() {},
    registerShortcut() {},
    registerCommand(_name: string, spec: { handler: typeof command }) {
      command = spec.handler;
    },
  } as unknown as ExtensionAPI);
  await command('', ctx);
  expect(complete.mock.calls.at(-1)?.[0]).toBe(mode === 'usable' ? preferred : current);
  expect(getAvailableOfType.mock.calls.length).toBe(mode === 'usable' ? 1 : 2);
  ctx.model = { ...current, id: 'changed' } as ExtensionContext['model'];
  await command('', ctx);
  expect(complete.mock.calls.at(-1)?.[0]).toBe(mode === 'usable' ? preferred : ctx.model);
  ctx.model = undefined;
  complete.mockClear();
  await command('', ctx);
  if (mode === 'usable') expect(complete).toHaveBeenCalled();
  else {
    expect(complete).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('No extraction or current session model'), 'error');
  }
});
