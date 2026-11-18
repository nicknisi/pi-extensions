import { describe, expect, it } from 'vitest';
import type { SpawnResult } from '@nicknisi/pi-shared';
import { backgroundNotice } from './background.js';

const fresh = { resumed: false, stopped: false };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const ok: SpawnResult = { ok: true, runId: 'abcdef123456', text: 'the answer', usage, durationMs: 5 };
const failed: SpawnResult = {
  ok: false,
  runId: 'abcdef123456',
  kind: 'crashed',
  error: 'boom',
  text: 'half done',
  usage,
  durationMs: 5,
};

describe('backgroundNotice', () => {
  it("wakes the parent with the child's answer", () => {
    const { message, options } = backgroundNotice('abcdef123456', 'scout', ok, fresh);
    expect(message.content).toBe('Background subagent abcdef12 (scout) completed\n\nthe answer');
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'steer' });
  });

  it('wakes the parent with the error and any partial output on failure', () => {
    const { message, options } = backgroundNotice('abcdef123456', 'scout', failed, fresh);
    expect(message.content).toBe('Background subagent abcdef12 (scout) failed: boom\n\nPartial output:\nhalf done');
    expect(message.details).toEqual({ runId: 'abcdef123456', ok: false });
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'steer' });
  });

  it('keeps a resumed run from starting a turn on its own', () => {
    const { message, options } = backgroundNotice('abcdef123456', 'scout', ok, { resumed: true, stopped: false });
    expect(message.content).toBe('Resumed subagent abcdef12 (scout) completed\n\nthe answer');
    expect(options).toEqual({});
  });

  it('does not start a turn for a run stopped by its cancel signal (cancel, or the session ending)', () => {
    const stopped: SpawnResult = { ...failed, kind: 'aborted', error: 'Interrupted when the pi session ended' };
    const { message, options } = backgroundNotice('abcdef123456', 'scout', stopped, { resumed: false, stopped: true });
    expect(message.content).toContain('failed: Interrupted when the pi session ended');
    expect(options).toEqual({});
  });

  it('wakes the parent when the child times out', () => {
    const timedOut: SpawnResult = { ...failed, kind: 'aborted', error: 'Timed out after 1000ms' };
    expect(backgroundNotice('abcdef123456', 'scout', timedOut, fresh).options).toEqual({
      triggerTurn: true,
      deliverAs: 'steer',
    });
  });

  it('caps the answer', () => {
    const long: SpawnResult = { ...ok, text: 'x'.repeat(10_000) };
    expect(backgroundNotice('abcdef123456', 'scout', long, fresh).message.content.length).toBeLessThan(4100);
  });
});
