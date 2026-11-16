import { describe, expect, it, vi } from 'vitest';

const calls: string[][] = [];
vi.mock('node:child_process', () => ({
  execFile: (_bin: string, args: string[], _opts: object, cb: () => void) => {
    calls.push(args);
    cb();
  },
}));

const { default: sidepulse } = await import('./index.js');

function harness(hasUI = true) {
  calls.length = 0;
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  sidepulse({ on: (name: string, fn: (event: any, ctx: any) => unknown) => handlers.set(name, fn) } as never);
  const ctx = {
    hasUI,
    cwd: '/work/proj',
    sessionManager: { getSessionId: () => 'abc', getSessionName: () => undefined },
  };
  const emit = (name: string, event: object = {}) => handlers.get(name)!(event, ctx);
  // Each report is queued; wait for the chain to drain.
  const states = async () => {
    await new Promise((r) => setTimeout(r, 0));
    return calls.map((a) => a[a.indexOf('--state') + 1]);
  };
  return { emit, states };
}

describe('sidepulse', () => {
  it('maps the pi lifecycle to SidePulse states', async () => {
    const { emit, states } = harness();
    emit('session_start');
    emit('agent_start');
    emit('ui_prompt_start', { kind: 'confirm', title: 'Allow?' });
    emit('ui_prompt_end');
    emit('agent_settled', { aborted: false });
    emit('ui_prompt_start', { kind: 'select' });
    emit('ui_prompt_end');
    emit('agent_start');
    emit('agent_settled', { aborted: true });
    await emit('session_shutdown');
    expect(await states()).toEqual([
      'idle',
      'working',
      'blocked',
      'working',
      'done',
      'blocked',
      'done',
      'working',
      'idle',
      'clear',
    ]);
    expect(calls[0]).toEqual(['report', '--scope', 'pi-abc', '--state', 'idle', '--app', 'pi', '--title', 'proj']);
    expect(calls[2]).toContain('permission');
    expect(calls[2]).toContain('Allow?');
    expect(calls[5]).toContain('question');
  });

  it('stays quiet without a UI (pi -p)', async () => {
    const { emit, states } = harness(false);
    emit('session_start');
    emit('agent_start');
    expect(await states()).toEqual([]);
  });
});
