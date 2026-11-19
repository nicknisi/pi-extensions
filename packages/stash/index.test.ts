import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import stash, { MAX_DRAFTS, preview, stashDir } from './index.js';

// Lets a test make the next directory listing fail, to simulate an I/O error after a commit.
const failures = vi.hoisted(() => ({ skip: 0, readdir: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readdirSync: ((...args: Parameters<typeof real.readdirSync>) => {
      if (failures.skip > 0) failures.skip--;
      else if (failures.readdir > 0) {
        failures.readdir--;
        throw new Error('EIO: simulated read failure');
      }
      return real.readdirSync(...args);
    }) as typeof real.readdirSync,
  };
});

let agentDir: string;
beforeEach(() => {
  agentDir = fs.mkdtempSync(join(tmpdir(), 'pi-stash-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  failures.skip = 0;
  failures.readdir = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

const saved = (cwd = '/work/repo') =>
  fs.existsSync(stashDir(cwd)) ? fs.readdirSync(stashDir(cwd)).filter((name) => name.endsWith('.json')) : [];

/** One pi window: an extension instance with its own editor and session id. */
function window(session: string, cwd = '/work/repo', mode = 'tui') {
  const registerShortcut = vi.fn<ExtensionAPI['registerShortcut']>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  stash({ registerShortcut, on: (name: string, h: never) => handlers.set(name, h) } as unknown as ExtensionAPI);
  const [key, { handler }] = registerShortcut.mock.calls[0]!;
  expect(key).toBe('ctrl+s');

  let text = '';
  const notify = vi.fn();
  const setWidget = vi.fn();
  const ctx = {
    hasUI: true,
    mode,
    cwd,
    sessionManager: { getSessionId: () => session },
    ui: {
      getEditorText: () => text,
      setEditorText: (value: string) => {
        text = value;
      },
      setWidget,
      notify,
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionContext;
  return {
    get text() {
      return text;
    },
    type: (value: string) => {
      text = value;
    },
    ctrlS: () => handler(ctx),
    /** A prompt typed in the editor and sent. */
    submit: async () => {
      await handlers.get('input')!({ type: 'input', text: 'hi', source: 'interactive' }, ctx);
      await handlers.get('before_agent_start')!({ type: 'before_agent_start', messageType: 'user' }, ctx);
    },
    /** A run started by another extension (sendUserMessage or sendMessage with triggerTurn). */
    extensionRun: async (messageType: 'user' | 'custom') => {
      if (messageType === 'user') await handlers.get('input')!({ type: 'input', text: 'hi', source: 'extension' }, ctx);
      await handlers.get('before_agent_start')!({ type: 'before_agent_start', messageType }, ctx);
    },
    start: () => handlers.get('session_start')!({}, ctx),
    notify,
    setWidget,
  };
}

it('stashes and restores drafts with Ctrl+S and shows the matching hint', async () => {
  const w = window('a');
  w.type('first draft');
  await w.ctrlS();
  expect(w.text).toBe('');
  expect(w.setWidget).toHaveBeenLastCalledWith('message-stash', [expect.stringContaining('ctrl+s to restore')]);

  w.type('second draft');
  await w.ctrlS();
  await w.ctrlS();
  expect(w.text).toBe('second draft');
  w.type('');
  await w.ctrlS();
  expect(w.text).toBe('first draft');
  expect(w.setWidget).toHaveBeenLastCalledWith('message-stash', undefined);
});

it('keeps stashes across a reload of the same session', async () => {
  const before = window('a');
  before.type('survives reload');
  await before.ctrlS();

  const after = window('a');
  await after.start();
  expect(after.setWidget).toHaveBeenLastCalledWith('message-stash', [expect.stringContaining('survives reload')]);
  await after.submit();
  expect(after.text).toBe('survives reload');
});

it("auto-restores only this session's drafts; Ctrl+S restores any window's", async () => {
  const a = window('a');
  const b = window('b');
  a.type('draft from A');
  await a.ctrlS();

  await b.submit();
  expect(b.text).toBe(''); // B's send must not pull in A's draft
  await b.ctrlS();
  expect(b.text).toBe('draft from A');
  await a.ctrlS();
  expect(a.text).toBe(''); // already claimed by B
});

it('does not auto-restore for runs started by extensions', async () => {
  const w = window('a');
  w.type('parked draft');
  await w.ctrlS();
  await w.extensionRun('custom');
  expect(w.text).toBe('');
  await w.extensionRun('user');
  expect(w.text).toBe('');
  expect(saved()).toHaveLength(1);
  await w.submit();
  expect(w.text).toBe('parked draft');
});

it('is a no-op outside the TUI, so RPC never claims a draft', async () => {
  const tuiWindow = window('a');
  tuiWindow.type('tui draft');
  await tuiWindow.ctrlS();

  const rpc = window('a', '/work/repo', 'rpc');
  await rpc.start();
  await rpc.submit();
  await rpc.ctrlS();
  expect(rpc.setWidget).not.toHaveBeenCalled();
  expect(saved()).toHaveLength(1);
});

it('keeps the newest drafts up to the cap', async () => {
  const w = window('a');
  for (let i = 0; i <= MAX_DRAFTS; i++) {
    w.type(`draft ${i}`);
    await w.ctrlS();
  }
  expect(saved()).toHaveLength(MAX_DRAFTS);
  w.type('');
  for (let i = MAX_DRAFTS; i >= 1; i--) {
    await w.ctrlS();
    expect(w.text).toBe(`draft ${i}`);
    w.type('');
  }
});

it('restores same-millisecond stashes newest first', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  try {
    const w = window('a');
    for (const text of ['one', 'two', 'three']) {
      w.type(text);
      await w.ctrlS();
    }
    for (const text of ['three', 'two', 'one']) {
      await w.ctrlS();
      expect(w.text).toBe(text);
      w.type('');
    }
  } finally {
    vi.restoreAllMocks();
  }
});

it('clears a stale widget when another window already took the draft', async () => {
  const a = window('a');
  const b = window('b');
  a.type('shared draft');
  await a.ctrlS();
  await b.ctrlS();
  expect(b.text).toBe('shared draft');
  await a.ctrlS(); // nothing left to restore
  expect(a.text).toBe('');
  expect(a.setWidget).toHaveBeenLastCalledWith('message-stash', undefined);
});

it('skips and keeps an unreadable draft file', async () => {
  fs.mkdirSync(stashDir('/work/repo'), { recursive: true });
  const junk = join(stashDir('/work/repo'), '0000000000000000-junk.json');
  fs.writeFileSync(junk, '{ not json');
  const w = window('a');
  w.type('good draft');
  await w.ctrlS();
  w.type('');
  await w.ctrlS();
  expect(w.text).toBe('good draft');
  expect(fs.readFileSync(junk, 'utf8')).toBe('{ not json');
});

it('keeps the editor text when the draft cannot be saved', async () => {
  fs.mkdirSync(join(agentDir, 'stash'), { recursive: true });
  fs.writeFileSync(stashDir('/work/repo'), 'a file where the folder should be');
  const w = window('a');
  w.type('precious draft');
  await w.ctrlS();
  expect(w.text).toBe('precious draft');
  expect(w.notify).toHaveBeenCalledWith(expect.stringContaining('Stash failed'), 'error');
});

it('still delivers a claimed draft when the widget refresh after it fails', async () => {
  const w = window('a');
  w.type('claimed draft');
  await w.ctrlS();
  w.type('');
  failures.skip = 1; // take()'s listing works and claims the draft…
  failures.readdir = 1; // …then the widget's listing fails
  await w.ctrlS();
  expect(w.text).toBe('claimed draft');
  expect(saved()).toHaveLength(0);
  expect(w.notify).toHaveBeenCalledWith(expect.stringContaining('simulated read failure'), 'error');
});

it('keeps a saved draft and clears the editor when the widget refresh fails', async () => {
  const w = window('a');
  w.type('saved draft');
  failures.readdir = 2; // trim's listing and the widget's listing both fail
  await w.ctrlS();
  expect(w.text).toBe('');
  expect(saved()).toHaveLength(1);
  expect(w.notify).toHaveBeenCalledWith(expect.stringContaining('simulated read failure'), 'error');
});

it('does not create a stash folder when there is nothing to stash', async () => {
  const w = window('a');
  await w.submit();
  await w.ctrlS();
  expect(fs.existsSync(stashDir('/work/repo'))).toBe(false);
});

it('previews the first line without control characters', () => {
  expect(preview('Evil\x1b[31m\x07draft\nsecond line')).toBe('Evil [31m draft');
});
