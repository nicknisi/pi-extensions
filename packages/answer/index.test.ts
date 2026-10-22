import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import answer from './index.js';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const reply = (text: string) => ({
  messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }],
});

/** `probability` undefined means no classifier is available at all. */
function harness(probability?: number) {
  const handlers = new Map<string, Handler>();
  const setStatus = vi.fn();
  const classify = vi.fn(async () => ({ stopReason: 'stop', answers: { q: { type: 'bool', probability } } }));
  const registry =
    probability === undefined
      ? {}
      : { getAvailableOfType: async () => [{ provider: 'typesafe', id: 'jev-latest' }], classify };
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => {},
    registerShortcut: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    modelRegistry: registry,
    ui: { setStatus, notify: vi.fn(), theme: { fg: (_c: string, s: string) => s } },
  } as unknown as ExtensionContext;
  answer(pi);
  const fire = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
  const hint = () => [...setStatus.mock.calls].reverse().find(([key]) => key === 'answer-hint')?.[1];
  return { classify, fire, hint };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'answer-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('answer hint', () => {
  it('shows the shortcut after a reply the classifier says asks questions', async () => {
    const h = harness(0.9);
    await h.fire('session_start');
    await h.fire('agent_end', reply('Which database should I use?'));
    await settle();
    expect(h.hint()).toBe('? ctrl+. to answer');
  });

  it('shows nothing when the classifier says no', async () => {
    const h = harness(0.1);
    await h.fire('session_start');
    await h.fire('agent_end', reply('Done. Why does this work? Because of caching.'));
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.hint()).toBeUndefined();
  });

  it('skips the classifier for replies without a question mark', async () => {
    const h = harness(0.9);
    await h.fire('session_start');
    await h.fire('agent_end', reply('All tests pass.'));
    await settle();
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('degrades to no hint without a classifier', async () => {
    const h = harness();
    await h.fire('session_start');
    await h.fire('agent_end', reply('Which database should I use?'));
    await settle();
    expect(h.hint()).toBeUndefined();
  });

  it('a new prompt clears the hint and beats a slow classifier', async () => {
    const h = harness(0.9);
    await h.fire('session_start');
    await h.fire('agent_end', reply('Which database should I use?'));
    await h.fire('input', { source: 'interactive', text: 'postgres' });
    await settle();
    expect(h.hint()).toBeUndefined();
  });
});
