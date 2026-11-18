import { createEventBus, initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { vi } from 'vitest';
import { registerAskUserQuestionTool } from '../ask-user-question.js';
import type { QuestionnaireSessionComponent } from '../state/questionnaire-session.js';
import type { QuestionnaireResult } from '../tool/types.js';
import { createMockCtx, createMockPi } from './pi.js';

/** pi-tui's defaults plus the app-level Ctrl+G binding Pi adds (`app.editor.external`). */
function withAppBindings() {
  const base = getKeybindings();
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'matches') {
        return (data: string, name: string) =>
          name === 'app.editor.external' ? data === '\x07' : target.matches(data, name as never);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const DEFAULT_QUESTION = {
  questions: [{ question: 'Which layout?', header: 'Layout', options: [{ label: 'Inline' }, { label: 'Overlay' }] }],
};

type Factory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (result: QuestionnaireResult) => void,
) => QuestionnaireSessionComponent;

/** One registered tool whose calls each mount a real dialog that stays open until something settles it. */
export function askTool(params: object = DEFAULT_QUESTION) {
  initTheme('dark');
  const bus = createEventBus();
  const { pi, captured } = createMockPi({ events: bus } as never);
  registerAskUserQuestionTool(pi);
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
  /** Start one tool call; resolves `mounted` once its dialog is on screen. */
  const call = (toolCallId = 'tc', signal?: AbortSignal, ui: object = {}) => {
    let component: QuestionnaireSessionComponent | undefined;
    let markMounted: () => void = () => {};
    const mounted = new Promise<void>((resolve) => (markMounted = resolve));
    const custom = vi.fn(
      (factory: Factory, options?: { overlay?: boolean }) =>
        new Promise<QuestionnaireResult>((resolve) => {
          component = factory(
            { requestRender() {}, terminal: { columns: 100, rows: 24 } },
            theme,
            withAppBindings(),
            resolve,
          );
          overlay = options?.overlay === true;
          markMounted();
        }),
    );
    let overlay = false;
    let settled = false;
    const ctx = createMockCtx({ hasUI: true, ui: { custom, notify: vi.fn(), ...ui } as never });
    (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted = () => true;
    const result = captured.tools.get('ask_user_question')!.execute!(
      toolCallId,
      params as never,
      signal,
      undefined,
      ctx as never,
    ).finally(() => (settled = true));
    return {
      result,
      mounted,
      press: (data: string) => component!.handleInput(data),
      render: (width = 100) => component!.render(width),
      isOverlay: () => overlay,
      isSettled: () => settled,
    };
  };
  return { call, bus };
}
