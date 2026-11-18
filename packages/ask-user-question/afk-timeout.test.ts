import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_TIMEOUT_MS, startAfkTimer, TIMEOUT_MESSAGE } from './afk-timeout.js';
import { ASK_USER_ANSWER_EVENT } from './events.js';
import { askTool } from './test-utils/dialog.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startAfkTimer', () => {
  it('fires once after the timeout unless stopped', () => {
    const onTimeout = vi.fn();
    startAfkTimer(onTimeout);
    vi.advanceTimersByTime(QUESTION_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();

    const stopped = vi.fn();
    const stop = startAfkTimer(stopped);
    stop();
    stop();
    vi.advanceTimersByTime(QUESTION_TIMEOUT_MS);
    expect(stopped).not.toHaveBeenCalled();
  });
});

function openDialog() {
  const { call, bus } = askTool();
  return { ...call(), bus };
}

describe('ask_user_question AFK timeout', () => {
  it('closes an untouched dialog and tells the model the user is away', async () => {
    const { result, mounted } = openDialog();
    await mounted;
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS);
    const r = await result;
    expect(r.content[0]).toEqual({ type: 'text', text: TIMEOUT_MESSAGE });
    expect(r.details).toEqual({ answers: [], cancelled: false, timedOut: true });
  });

  it('waits indefinitely once the user has touched the dialog', async () => {
    const { result, mounted, press } = openDialog();
    await mounted;
    press('\x1b[B'); // move to the second option
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS * 3);
    press('\r');
    const r = await result;
    expect(r.details).toMatchObject({ cancelled: false, answers: [{ kind: 'option', answer: 'Overlay' }] });
    expect(r.details).not.toHaveProperty('timedOut');
  });

  it('does not time out after an answer arrives through the answer event', async () => {
    const { result, mounted, bus } = openDialog();
    await mounted;
    bus.emit(ASK_USER_ANSWER_EVENT, { toolCallId: 'tc', answers: [{ questionIndex: 0, optionIndexes: [0] }] });
    const r = await result;
    expect(r.details).toMatchObject({ answers: [{ answer: 'Inline' }] });
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS);
    expect(r.details).not.toHaveProperty('timedOut');
  });

  it('keeps an inline dialog open while an overlay questionnaire is still open', async () => {
    const { call } = askTool();
    const a = call('a');
    await a.mounted;
    const b = call('b');
    await b.mounted;
    expect([a.isOverlay(), b.isOverlay()]).toEqual([false, true]);
    b.press('\x1b[B'); // the user is answering B
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS * 2);
    // Closing inline A now would move Pi's focus to its main editor and strand B.
    expect(a.isSettled()).toBe(false);
    b.press('\r');
    expect((await b.result).details).toMatchObject({ answers: [{ answer: 'Overlay' }] });
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS);
    expect((await a.result).details).toMatchObject({ timedOut: true });
  });

  it('closes the dialog as a cancel when the tool call is aborted', async () => {
    const { call } = askTool();
    const controller = new AbortController();
    const q = call('tc', controller.signal);
    await q.mounted;
    q.press('\x1b[B'); // touched, so the timer is not what closes it
    controller.abort();
    expect((await q.result).details).toMatchObject({ answers: [], cancelled: true });
  });
});
