/**
 * Auto-rename tests: the drift check runs every `renameEvery` user prompts,
 * renames only names this extension set, and needs a classifier.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

let dir: string;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'session-name-rename-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  mkdirSync(join(dir, 'configs'));
  writeFileSync(join(dir, 'configs/session-name.json'), JSON.stringify({ setTitle: false, renameEvery: 2 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

const user = (text: string) => ({ type: 'message', message: { role: 'user', content: text } }) as SessionEntry;

async function harness(opts: { probability?: number; classifier?: boolean } = {}) {
  const { default: extension } = await import('./index.js');
  const handlers = new Map<string, Handler>();
  const entries: SessionEntry[] = [];
  let name = '';
  const setSessionName = vi.fn((n: string) => {
    name = n;
  });
  const appendEntry = vi.fn((customType: string, data?: unknown) => {
    entries.push({ type: 'custom', customType, data } as SessionEntry);
  });
  const notify = vi.fn();
  const classify = vi.fn(async () => ({
    stopReason: 'stop',
    answers: { q: { type: 'bool', probability: opts.probability ?? 0.95 } },
  }));
  const ctx = {
    hasUI: true,
    cwd: '/tmp/work',
    ui: { notify, setTitle() {} },
    sessionManager: { getBranch: () => entries, getEntries: () => entries },
    modelRegistry: {
      getAvailableOfType: async () => (opts.classifier === false ? [] : [{ provider: 'typesafe', id: 'jev-latest' }]),
      classify,
    },
  } as unknown as ExtensionContext;
  extension({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: () => {},
    getSessionName: () => name || undefined,
    setSessionName,
    appendEntry,
  } as unknown as ExtensionAPI);

  /** Send a user prompt and let the run settle. */
  const prompt = async (text: string) => {
    entries.push(user(text));
    handlers.get('before_agent_start')!({ prompt: text, messageType: 'user' }, ctx);
    await settle();
    handlers.get('agent_settled')!({ aborted: false }, ctx);
    for (let i = 0; i < 5; i++) await settle();
  };
  const rename = (n: string) => {
    name = n;
  };
  handlers.get('session_start')!({}, ctx);
  return { prompt, rename, setSessionName, appendEntry, classify, notify, current: () => name };
}

it('renames an auto-named session when the classifier says the task changed', async () => {
  const h = await harness();
  await h.prompt('Fix the flaky login test');
  expect(h.current()).toBe('Fix the flaky login test');
  await h.prompt('Now add dark mode to settings');
  expect(h.classify).not.toHaveBeenCalled(); // one prompt since naming, renameEvery is 2
  await h.prompt('Make the dark mode toggle persist');
  expect(h.classify).toHaveBeenCalledTimes(1);
  expect(h.current()).toBe('Make the dark mode toggle persist');
  expect(h.appendEntry).toHaveBeenLastCalledWith('session-name-auto', { name: 'Make the dark mode toggle persist' });
  expect(h.notify).toHaveBeenCalledWith('Session renamed: Make the dark mode toggle persist', 'info');
});

it('keeps the name when the classifier is below the threshold', async () => {
  const h = await harness({ probability: 0.4 });
  await h.prompt('Fix the flaky login test');
  await h.prompt('Also check the retry logic there');
  await h.prompt('And add a regression test for it');
  expect(h.classify).toHaveBeenCalledTimes(1);
  expect(h.current()).toBe('Fix the flaky login test');
});

it('never renames a name the user set', async () => {
  const h = await harness();
  await h.prompt('Fix the flaky login test');
  h.rename('login work'); // e.g. /name or /sn: no auto entry for this name
  await h.prompt('Now add dark mode to settings');
  await h.prompt('Make the dark mode toggle persist');
  expect(h.classify).not.toHaveBeenCalled();
  expect(h.current()).toBe('login work');
});

it('retries on the next settle once a classifier becomes available', async () => {
  const opts = { classifier: false };
  const h = await harness(opts);
  await h.prompt('Fix the flaky login test');
  await h.prompt('Now add dark mode to settings');
  await h.prompt('Make the dark mode toggle persist');
  expect(h.classify).not.toHaveBeenCalled();
  opts.classifier = true; // e.g. credentials added mid-session
  await h.prompt('Add a keyboard shortcut for dark mode');
  expect(h.classify).toHaveBeenCalledTimes(1);
});

it('does nothing without a classifier', async () => {
  const h = await harness({ classifier: false });
  await h.prompt('Fix the flaky login test');
  await h.prompt('Now add dark mode to settings');
  await h.prompt('Make the dark mode toggle persist');
  expect(h.classify).not.toHaveBeenCalled();
  expect(h.current()).toBe('Fix the flaky login test');
});
