import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import stash, { MAX_DRAFTS, preview, stashFile } from './index.js';

let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-stash-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

/** One pi window: an extension instance with its own editor and session id. */
function window(session: string, cwd = '/work/repo') {
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
    submit: () => handlers.get('before_agent_start')!({}, ctx),
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
});

it('keeps the newest drafts up to the cap', async () => {
  const w = window('a');
  for (let i = 0; i <= MAX_DRAFTS; i++) {
    w.type(`draft ${i}`);
    await w.ctrlS();
  }
  const saved = JSON.parse(readFileSync(stashFile('/work/repo'), 'utf8'));
  expect(saved).toHaveLength(MAX_DRAFTS);
  expect(saved[0].text).toBe('draft 1');
});

it('never overwrites an unreadable stash file, and keeps the editor text', async () => {
  const file = stashFile('/work/repo');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{ not json');
  const w = window('a');
  w.type('precious draft');
  await w.ctrlS();
  expect(w.text).toBe('precious draft');
  expect(readFileSync(file, 'utf8')).toBe('{ not json');
  expect(w.notify).toHaveBeenCalledWith(expect.stringContaining('Stash failed'), 'error');
});

it('does not create a stash file when there is nothing to stash', async () => {
  const w = window('a');
  await w.submit();
  await w.ctrlS();
  expect(existsSync(stashFile('/work/repo'))).toBe(false);
});

it('previews the first line without control characters', () => {
  expect(preview('Evil\x1b[31m\x07draft\nsecond line')).toBe('Evil [31m draft');
});

it('releases the lock after saving, and reclaims one left by a crashed window', async () => {
  const w = window('a');
  const lock = `${stashFile('/work/repo')}.lock`;
  w.type('first');
  await w.ctrlS();
  expect(existsSync(lock)).toBe(false);

  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  w.type('second');
  await w.ctrlS();
  expect(w.text).toBe('');
  expect(JSON.parse(readFileSync(stashFile('/work/repo'), 'utf8'))).toHaveLength(2);
});

it('waits for a window holding the lock, then gives up without losing the draft', async () => {
  const w = window('a');
  w.type('seed');
  await w.ctrlS();
  mkdirSync(`${stashFile('/work/repo')}.lock`); // held by another window right now
  w.type('precious draft');
  await w.ctrlS();
  expect(w.text).toBe('precious draft');
  expect(w.notify).toHaveBeenCalledWith(expect.stringContaining('busy in another window'), 'error');
  expect(JSON.parse(readFileSync(stashFile('/work/repo'), 'utf8'))).toHaveLength(1);
});
