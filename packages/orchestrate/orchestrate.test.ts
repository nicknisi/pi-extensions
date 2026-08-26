/**
 * Regression test for the "/goal stop doesn't work" report.
 *
 * The runaway state file showed `goal: null` with a 326-iteration /loop —
 * clearGoal() returned "No goal set" and never touched the loop. The fix:
 * /goal stop|clear stops a running loop too and aborts the in-flight turn.
 *
 * The extension module holds goal/loop in module-level state, so the tests
 * drive it through the captured command handlers with a stub ctx, the same
 * way pi would.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import factory from './index.js';

let cwd: string;

function makeHarness() {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  const sent: string[] = [];
  const api = {
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => void }) =>
      commands.set(name, def.handler),
    on: () => {},
    sendUserMessage: (text: string) => {
      sent.push(text);
    },
  };
  const notifications: string[] = [];
  const abort = vi.fn();
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (msg: string) => notifications.push(msg),
      setStatus: () => {},
    },
    sessionManager: { getSessionFile: () => path.join(cwd, 'session.jsonl') },
    isIdle: () => true,
    abort,
  };
  factory(api as never);
  return { commands, sent, notifications, abort, ctx };
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orchestrate-test-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('/goal stop', () => {
  it('stops a running loop even when no goal is set', async () => {
    const h = makeHarness();
    await h.commands.get('loop')!('run greptile review --agent until 5/5', h.ctx);
    // Loop is live: it sent its first tick continuation.
    expect(h.sent.some((m) => m.includes('greptile'))).toBe(true);

    await h.commands.get('goal')!('stop', h.ctx);
    expect(h.notifications.some((n) => n.includes('Loop stopped'))).toBe(true);
    expect(h.abort).toHaveBeenCalled();

    // The loop must stay dead across an agent_end (this is what fired 326 times).
    h.sent.length = 0;
    await h.commands.get('goal')!('', h.ctx); // status — also proves no goal adopted
    expect(h.notifications.some((n) => n.includes('No goal set'))).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it('clears an active goal and aborts the in-flight turn', async () => {
    const h = makeHarness();
    await h.commands.get('goal')!('all tests pass', h.ctx);
    expect(h.sent).toEqual(['all tests pass']);

    await h.commands.get('goal')!('stop', h.ctx);
    expect(h.notifications.some((n) => n.includes('Goal cleared: all tests pass'))).toBe(true);
    expect(h.abort).toHaveBeenCalled();
  });

  it('with nothing running, says so and does NOT abort an unrelated turn', async () => {
    const h = makeHarness();
    await h.commands.get('goal')!('stop', h.ctx);
    expect(h.notifications).toEqual(['No goal set']);
    expect(h.abort).not.toHaveBeenCalled();
  });
});
