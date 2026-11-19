/**
 * Prompt extraction and `/sn` tests: skill-expanded prompts, the persisted
 * `/sn clear` opt-out, and names that clean down to nothing.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

let dir: string;
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'session-name-naming-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  mkdirSync(join(dir, 'configs'));
  writeFileSync(join(dir, 'configs/session-name.json'), JSON.stringify({ setTitle: false, notifyOnAutoName: false }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

const skill = (args?: string) =>
  `<skill name="fix-parser" location="/Users/me/.pi/skills/fix-parser/SKILL.md">\nReferences are relative to /Users/me/.pi/skills/fix-parser.\n\nLong skill body text here.\n</skill>${args ? `\n\n${args}` : ''}`;

describe('taskText', () => {
  it('names from the args after a skill block, else the skill name', async () => {
    const { taskText } = await import('./index.js');
    expect(taskText(skill('fix the flaky login test'))).toBe('fix the flaky login test');
    expect(taskText(skill())).toBe('fix-parser');
    expect(taskText(skill('ok'))).toBe('fix-parser');
    expect(taskText('Fix the parser')).toBe('Fix the parser');
    expect(taskText('ok')).toBeUndefined();
  });
});

async function harness(entries: SessionEntry[] = []) {
  const { default: extension } = await import('./index.js');
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  let name = '';
  const setSessionName = vi.fn((n: string) => {
    name = n;
  });
  const appendEntry = vi.fn((customType: string) => {
    entries.push({ type: 'custom', customType } as SessionEntry);
  });
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    cwd: '/tmp/work',
    ui: { notify, setTitle() {} },
    sessionManager: { getBranch: () => [], getEntries: () => entries },
  } as unknown as ExtensionContext;
  extension({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (cmd: string, opts: Command) => commands.set(cmd, opts),
    getSessionName: () => name || undefined,
    setSessionName,
    appendEntry,
  } as unknown as ExtensionAPI);
  const fire = (event: string, prompt = 'Fix the flaky login test') =>
    handlers.get(event)!({ prompt, messageType: 'user' }, ctx);
  const sn = (args: string) => commands.get('sn')!.handler(args, ctx);
  return { ctx, entries, setSessionName, appendEntry, notify, fire, sn };
}

it('auto-names a skill invocation from its args, not the skill block', async () => {
  const h = await harness();
  h.fire('session_start');
  h.fire('before_agent_start', skill('fix the flaky login test'));
  await settle();
  expect(h.setSessionName).toHaveBeenCalledWith('fix the flaky login test');
});

it('keeps the /sn clear opt-out across a reload', async () => {
  const first = await harness();
  first.fire('session_start');
  await first.sn('clear');
  expect(first.appendEntry).toHaveBeenCalledWith('session-name-cleared');

  // A fresh runtime over the same session entries.
  const second = await harness(first.entries);
  second.fire('session_start');
  second.fire('before_agent_start');
  await settle();
  expect(second.setSessionName).not.toHaveBeenCalled();
});

it('rejects a /sn name that is empty after cleaning', async () => {
  const h = await harness();
  await h.sn('\x1b\x07\u202E');
  expect(h.setSessionName).not.toHaveBeenCalled();
  expect(h.notify).toHaveBeenCalledWith(expect.any(String), 'error');
});
