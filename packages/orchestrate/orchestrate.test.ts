import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import factory from './index.js';

const modelStream = vi.fn();

let cwd: string;
let cleanup: (() => void) | undefined;

type Handler = (event: any, ctx: any) => Promise<void> | void;

function entry(id: string, role: string, text: string, extra = {}) {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text }], ...extra },
  };
}

function makeHarness(sessionFile = 'session.jsonl') {
  const commands = new Map<string, Handler>();
  const events = new Map<string, Handler>();
  const sent: string[] = [];
  const notifications: string[] = [];
  const statuses: string[] = [];
  const abort = vi.fn();
  const entries = [
    entry('request', 'user', 'Make the tests pass'),
    entry('call', 'assistant', '', {
      content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pnpm test' } }],
    }),
    entry('result', 'toolResult', 'Tests: 3 passed', { toolName: 'bash', toolCallId: 'call-1', isError: false }),
    entry('answer', 'assistant', 'All tests pass.'),
  ];
  const ctx = {
    cwd,
    hasUI: true,
    model: { id: 'current-model' },
    modelRegistry: { streamSimple: modelStream },
    ui: {
      notify: (msg: string) => notifications.push(msg),
      setStatus: (_key: string, status: string) => statuses.push(status),
    },
    sessionManager: {
      getSessionFile: () => path.join(cwd, sessionFile),
      getBranch: () => entries,
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort,
  };
  factory({
    registerCommand: (name: string, def: { handler: Handler }) => commands.set(name, def.handler),
    on: (name: string, handler: Handler) => events.set(name, handler),
    sendUserMessage: (text: string) => sent.push(text),
  } as never);
  const event = (name: string, value: unknown = {}) => events.get(name)!(value, ctx);
  const command = (args: string) => commands.get('goal')!(args, ctx);
  // Reset module-held state exactly as a new pi session does.
  void event('session_start');
  cleanup = () => {
    void event('session_shutdown');
  };
  return { commands, sent, notifications, statuses, abort, ctx, entries, event, command };
}

function evaluator(text: string, stopReason = 'stop') {
  const result = vi.fn(async () => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }] }));
  modelStream.mockImplementation(() => ({ result }));
  return {
    result,
    prompt: (i = 0) => modelStream.mock.calls[i]![1].messages[0].content[0].text as string,
    signal: (i = 0) => modelStream.mock.calls[i]![2].signal as AbortSignal,
  };
}

function verdict(verdict: string, evidence: string[] = [], basis = 'tool') {
  return JSON.stringify({
    verdict,
    reason: verdict === 'unknown' ? 'Run the missing check.' : 'Observed test results.',
    basis,
    evidence,
  });
}

function saved(name = 'session') {
  return JSON.parse(fs.readFileSync(path.join(cwd, `.pi-goal/${name}.json`), 'utf8'));
}

beforeEach(() => {
  vi.clearAllMocks();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orchestrate-test-'));
});

afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('/goal stop', () => {
  it('stops a running loop even when no goal is set', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.commands.get('loop')!('run greptile review --agent until 5/5', h.ctx);
    expect(h.sent.some((m) => m.includes('greptile'))).toBe(true);
    await h.command('stop');
    expect(h.notifications.some((n) => n.includes('Loop stopped'))).toBe(true);
    expect(h.abort).toHaveBeenCalled();
    h.sent.length = 0;
    await h.event('agent_end');
    await h.event('agent_settled');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toEqual([]);
  });

  it('ticks a self-paced loop when the run settles, not at agent_end', async () => {
    const h = makeHarness();
    await h.commands.get('loop')!('keep going', h.ctx);
    expect(h.sent).toEqual(['keep going']);
    await h.event('agent_end');
    expect(h.sent).toHaveLength(1);
    await h.event('agent_settled');
    expect(h.sent).toEqual(['keep going', 'keep going']);
    await h.event('agent_settled');
    expect(h.sent).toHaveLength(2);
  });

  it('clears an active goal and aborts the in-flight turn', async () => {
    const h = makeHarness();
    await h.command('all tests pass');
    expect(h.sent).toEqual(['all tests pass']);
    await h.command('stop');
    expect(h.notifications.some((n) => n.includes('Goal cleared: all tests pass'))).toBe(true);
    expect(h.abort).toHaveBeenCalled();
  });

  it('does not abort an unrelated turn when nothing is running', async () => {
    const h = makeHarness();
    await h.command('stop');
    expect(h.notifications).toEqual(['No goal set']);
    expect(h.abort).not.toHaveBeenCalled();
  });
});

describe('evidence-based evaluation', () => {
  it('uses the current model, real tool metadata, and validates completion references', async () => {
    const h = makeHarness();
    const e = evaluator(verdict('met', ['result']));
    await h.command('all tests pass');
    await h.event('agent_end');
    expect(modelStream).toHaveBeenCalledWith(
      h.ctx.model,
      expect.objectContaining({ systemPrompt: expect.stringContaining('No tools are available') }),
      expect.objectContaining({ reasoning: 'minimal' }),
    );
    const prompt = JSON.parse(e.prompt());
    expect(prompt.evidence.join('\n')).toContain('pnpm test');
    expect(prompt.evidence.join('\n')).toContain('"isError":false');
    expect(h.notifications.at(-1)).toContain('Goal achieved');
    expect(h.notifications.at(-1)).toContain('Evidence: result');
    expect(h.sent).toHaveLength(1);
    expect(fs.existsSync(path.join(cwd, '.pi-goal/session.json'))).toBe(false);
  });

  it('accepts a single JSON fence without accepting surrounding prose', async () => {
    const h = makeHarness();
    evaluator('```json\n' + verdict('met', ['result']) + '\n```');
    await h.command('all tests pass');
    await h.event('agent_end');
    expect(h.notifications.at(-1)).toContain('Goal achieved');
  });

  it('accepts a fence with the JSON on the same line', async () => {
    const h = makeHarness();
    evaluator('```json ' + verdict('met', ['result']) + ' ```');
    await h.command('all tests pass');
    await h.event('agent_end');
    expect(h.notifications.at(-1)).toContain('Goal achieved');
  });

  it('allows an actual assistant deliverable for answer-only goals', async () => {
    const h = makeHarness();
    evaluator(verdict('met', ['answer'], 'answer'));
    await h.command('write a short explanation');
    await h.event('agent_end');
    expect(h.notifications.at(-1)).toContain('Goal achieved');
  });

  it.each([
    'YES\nLooks done.',
    '',
    verdict('met'),
    verdict('met', ['invented']),
    verdict('met', ['answer']),
    verdict('met', ['request'], 'answer'),
  ])('pauses on malformed or ungrounded verdict %s', async (text) => {
    const h = makeHarness();
    evaluator(text);
    await h.command('all tests pass');
    await h.event('agent_end');
    expect(h.sent).toHaveLength(1);
    expect(saved().goal.pausedReason).toContain('Evaluator unavailable');
    expect(h.notifications.some((n) => n.includes('Goal achieved'))).toBe(false);
  });

  it('does not trust a partial response when the provider errors', async () => {
    const h = makeHarness();
    const e = evaluator(verdict('met', ['result']), 'error');
    await h.command('all tests pass');
    await h.event('agent_end');
    expect(saved().goal.pausedReason).toContain('Evaluator stopped: error');
    expect(e.result).toHaveBeenCalledOnce();
  });

  it('keeps the end of huge tool output rather than discarding all earlier evidence', async () => {
    const h = makeHarness();
    h.entries[2]!.message.content = [{ type: 'text', text: 'x'.repeat(40_000) + '\nTests: 3 passed' }];
    const e = evaluator(verdict('not_met'));
    await h.command('all tests pass');
    await h.event('agent_end');
    const prompt = JSON.parse(e.prompt());
    expect(prompt.evidence.join('\n')).toContain('Tests: 3 passed');
    expect(prompt.evidence.join('\n')).toContain('pnpm test');
    expect(prompt.evidence.join('\n')).toContain('content truncated');
    expect(prompt.evidence.join('\n').length).toBeLessThan(20_000);
  });

  it('includes direct shell exit codes but excludes hidden shell commands', async () => {
    const h = makeHarness();
    h.entries.push(
      entry('shell', 'bashExecution', '', {
        command: 'pnpm test',
        output: 'tests failed',
        exitCode: 1,
        cancelled: false,
      }),
    );
    h.entries.push(
      entry('private', 'bashExecution', '', { command: 'secret-command', output: 'secret', excludeFromContext: true }),
    );
    const e = evaluator(verdict('not_met'));
    await h.command('all tests pass');
    await h.event('agent_end');
    const prompt = e.prompt();
    expect(prompt).toContain('exitCode');
    expect(prompt).not.toContain('secret-command');
  });

  it('treats no evidence as unknown without calling a model', async () => {
    const h = makeHarness();
    h.entries.length = 0;
    await h.command('all tests pass');
    await h.event('agent_end');
    expect(modelStream).not.toHaveBeenCalled();
    expect(saved().goal.lastVerdict).toBe('unknown');
    expect(h.sent.at(-1)).toContain('Gather the missing evidence');
  });
});

describe('continuation budgets and recovery', () => {
  it('allows one evidence-gathering retry, then pauses on consecutive unknowns', async () => {
    const h = makeHarness();
    evaluator(verdict('unknown'));
    await h.command('all tests pass');
    await h.event('agent_end');
    expect(h.sent.at(-1)).toContain('needs verification');
    await h.event('agent_end');
    expect(saved().goal.pausedReason).toContain('Unable to verify completion twice');
    await h.event('agent_end');
    expect(h.sent).toHaveLength(2);
    expect(modelStream).toHaveBeenCalledTimes(2);
  });

  it('pauses after ten unsuccessful runs and resume grants a fresh budget', async () => {
    const h = makeHarness();
    evaluator(verdict('not_met'));
    await h.command('all tests pass');
    for (let i = 0; i < 12; i++) await h.event('agent_end');
    expect(modelStream).toHaveBeenCalledTimes(10);
    expect(h.sent).toHaveLength(10);
    expect(saved().goal.pausedReason).toContain('Reached 10 goal runs');
    await h.command('resume');
    expect(saved().goal.turns).toBe(0);
    expect(saved().goal.pausedReason).toBeUndefined();
    await h.event('agent_end');
    expect(modelStream).toHaveBeenCalledTimes(11);
  });

  it('pauses at the next boundary after thirty minutes, stopping a concurrent loop', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.commands.get('loop')!('5m maintenance', h.ctx);
    await h.command('all tests pass');
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await h.event('agent_end');
    expect(saved().goal.pausedReason).toContain('30-minute');
    expect(saved().loop).toBeNull();
    expect(modelStream).not.toHaveBeenCalled();
    const count = h.sent.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sent).toHaveLength(count);
  });

  it('pauses immediately on evaluator failure rather than sending more work', async () => {
    const h = makeHarness();
    modelStream.mockReturnValue({ result: async () => Promise.reject(new Error('provider offline')) });
    await h.command('all tests pass');
    await h.event('agent_end');
    expect(saved().goal.pausedReason).toContain('provider offline');
    expect(h.sent).toHaveLength(1);
  });

  it('times out a stuck evaluator and disposes the session', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const e = evaluator('');
    e.result.mockImplementation(() => new Promise(() => {}));
    await h.command('all tests pass');
    const pending = h.event('agent_end');
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(saved().goal.pausedReason).toContain('timed out');
    expect(e.signal().aborted).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  it('persists pauses across restart and compaction cannot restart a paused goal', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    evaluator('bad verdict');
    await h.command('all tests pass');
    await h.event('agent_end');
    await h.event('session_start');
    await h.event('session_compact');
    await h.event('agent_end');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toHaveLength(1);
    expect(h.statuses.at(-1)).toContain('paused');
  });

  it('does not resurrect an interrupted or failed agent run', async () => {
    const h = makeHarness();
    await h.command('all tests pass');
    await h.event('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    expect(saved().goal.pausedReason).toContain('Agent stopped: aborted');
    expect(modelStream).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
  });

  it('cancels stale evaluation when the user replaces the goal', async () => {
    const h = makeHarness();
    const e = evaluator(verdict('met', ['result']));
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    e.result.mockImplementation(async () => {
      started();
      return new Promise(() => {});
    });
    await h.command('old goal');
    const pending = h.event('agent_end');
    await ready;
    await h.command('new goal');
    await pending;
    expect(saved().goal.condition).toBe('new goal');
    expect(saved().goal.lastVerdict).toBeUndefined();
    expect(e.signal().aborted).toBe(true);
    expect(h.sent).toEqual(['old goal', 'new goal']);
  });

  it('does not duplicate goal work when compaction overlaps an evaluation', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const e = evaluator(verdict('not_met'));
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    e.result.mockImplementation(async () => {
      started();
      return new Promise(() => {});
    });
    await h.command('all tests pass');
    const pending = h.event('agent_end');
    await ready;
    await h.event('session_compact');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toHaveLength(1);
    await h.command('clear');
    await pending;
  });

  it('does not enqueue a compaction continuation when work is already queued', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.ctx.hasPendingMessages = () => true;
    await h.command('all tests pass');
    await h.event('session_compact');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toHaveLength(1);
  });

  it('does not send an old compaction continuation to a replacement goal', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.command('old goal');
    await h.event('session_compact');
    await h.command('new goal');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toEqual(['old goal', 'new goal']);
  });

  it('does not tick a self-paced loop after compaction when agent_settled already started a run', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.commands.get('loop')!('keep going', h.ctx);
    await h.event('agent_end');
    await h.event('session_compact');
    await h.event('agent_settled');
    h.ctx.isIdle = () => false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toEqual(['keep going', 'keep going']);
  });

  it('skips the compaction loop tick while a settle tick is pending or work is queued', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.commands.get('loop')!('keep going', h.ctx);
    await h.event('agent_end');
    await h.event('session_compact');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toHaveLength(1);
    await h.event('agent_settled');
    expect(h.sent).toHaveLength(2);
    h.ctx.hasPendingMessages = () => true;
    await h.event('session_compact');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toHaveLength(2);
  });

  it('still ticks a self-paced loop after a manual compaction when idle', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.commands.get('loop')!('keep going', h.ctx);
    await h.event('session_compact');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toEqual(['keep going', 'keep going']);
  });
});

describe('per-session persistence', () => {
  it('a second session in the same cwd never overwrites or deletes the first session state', async () => {
    const a = makeHarness('a.jsonl');
    fs.writeFileSync(path.join(cwd, 'a.jsonl'), '');
    await a.command('all tests pass');
    expect(saved('a').owner).toBe(path.join(cwd, 'a.jsonl'));
    cleanup?.();

    const b = makeHarness('b.jsonl');
    await b.command('clear');
    await b.commands.get('loop')!('5m other work', b.ctx);
    await b.commands.get('loop')!('stop', b.ctx);
    await b.command('other goal');
    expect(saved('b').goal.condition).toBe('other goal');
    expect(saved('a').goal.condition).toBe('all tests pass');
    await b.command('clear');
    expect(fs.existsSync(path.join(cwd, '.pi-goal/b.json'))).toBe(false);
    cleanup?.();

    // --resume of the first session restores its goal.
    const resumed = makeHarness('a.jsonl');
    await resumed.command('');
    expect(resumed.notifications.at(-1)).toContain('Goal: all tests pass');
  });
});
