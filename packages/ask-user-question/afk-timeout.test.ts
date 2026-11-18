import { createEventBus, initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_TIMEOUT_MS, startAfkTimer, TIMEOUT_MESSAGE } from './afk-timeout.js';
import { ASK_USER_ANSWER_EVENT } from './events.js';
import { registerAskUserQuestionTool } from './ask-user-question.js';
import type { QuestionnaireSessionComponent } from './state/questionnaire-session.js';
import { createMockCtx, createMockPi } from './test-utils/index.js';
import type { QuestionnaireResult } from './tool/types.js';

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

type Factory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (result: QuestionnaireResult) => void,
) => QuestionnaireSessionComponent;

const question = {
  questions: [{ question: 'Which layout?', header: 'Layout', options: [{ label: 'Inline' }, { label: 'Overlay' }] }],
};

/** Run the real tool with a mounted dialog that stays open until something settles it. */
function openDialog() {
  initTheme('dark');
  const bus = createEventBus();
  const { pi, captured } = createMockPi({ events: bus } as never);
  registerAskUserQuestionTool(pi);
  let component: QuestionnaireSessionComponent | undefined;
  let markMounted: () => void = () => {};
  const mounted = new Promise<void>((resolve) => (markMounted = resolve));
  const custom = vi.fn(
    (factory: Factory) =>
      new Promise<QuestionnaireResult>((resolve) => {
        const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
        component = factory(
          { requestRender() {}, terminal: { columns: 100, rows: 24 } },
          theme,
          getKeybindings(),
          resolve,
        );
        markMounted();
      }),
  );
  const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });
  const result = captured.tools.get('ask_user_question')!.execute!(
    'tc',
    question as never,
    undefined,
    undefined,
    ctx as never,
  );
  const press = (data: string) => component!.handleInput(data);
  return { result, mounted, press, bus };
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
});
