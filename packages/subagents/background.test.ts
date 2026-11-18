import { describe, expect, it } from 'vitest';
import type { SpawnResult } from '@nicknisi/pi-shared';
import { backgroundNotice } from './background.js';

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
    const { message, options } = backgroundNotice('abcdef123456', 'scout', ok, false);
    expect(message.content).toBe('Background subagent abcdef12 (scout) completed\n\nthe answer');
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'steer' });
  });

  it('wakes the parent with the error and any partial output on failure', () => {
    const { message, options } = backgroundNotice('abcdef123456', 'scout', failed, false);
    expect(message.content).toBe('Background subagent abcdef12 (scout) failed: boom\n\nPartial output:\nhalf done');
    expect(message.details).toEqual({ runId: 'abcdef123456', ok: false });
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'steer' });
  });

  it('keeps a resumed run from starting a turn on its own', () => {
    const { message, options } = backgroundNotice('abcdef123456', 'scout', ok, true);
    expect(message.content).toBe('Resumed subagent abcdef12 (scout) completed\n\nthe answer');
    expect(options).toEqual({});
  });

  it('caps the answer', () => {
    const long: SpawnResult = { ...ok, text: 'x'.repeat(10_000) };
    expect(backgroundNotice('abcdef123456', 'scout', long, false).message.content.length).toBeLessThan(4100);
  });
});
