import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import answer, {
  AnswerComponent,
  buildAnswerMessage,
  fallbackExtractQuestions,
  findLastCompletedAssistantMessage,
  getJsonCandidates,
  parseExtractionResult,
} from './index.js';

vi.mock('@earendil-works/pi-coding-agent', async (original) => ({
  ...(await original<typeof import('@earendil-works/pi-coding-agent')>()),
  BorderedLoader: class {
    signal = new AbortController().signal;
  },
}));

const questions = (text: string) => fallbackExtractQuestions(text).questions.map((q) => q.question);

describe('parseExtractionResult', () => {
  it('reads plain, fenced, and brace-wrapped JSON', () => {
    const json = '{"questions":[{"question":"Which DB?","context":"For prod"}]}';
    for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `Sure! ${json} Hope that helps.`]) {
      expect(parseExtractionResult(text)).toEqual({
        type: 'success',
        result: { questions: [{ question: 'Which DB?', context: 'For prod' }] },
      });
    }
    expect(getJsonCandidates(`x \`\`\`\n${json}\n\`\`\``)).toContain(json);
  });

  it('reports invalid JSON as an error', () => {
    expect(parseExtractionResult('not json {').type).toBe('error');
    expect(parseExtractionResult('{"answers":[]}').type).toBe('error');
  });

  it('skips malformed items and dedupes', () => {
    const text = JSON.stringify({
      questions: [null, 3, { question: 42 }, { question: ' A? ', context: 7 }, { question: 'a?' }, { question: 'B?' }],
    });
    expect(parseExtractionResult(text)).toEqual({
      type: 'success',
      result: {
        questions: [
          { question: 'A?', context: undefined },
          { question: 'B?', context: undefined },
        ],
      },
    });
  });
});

describe('fallbackExtractQuestions', () => {
  it('keeps dotted words inside a question', () => {
    expect(questions('Should I bump to v1.2 or v2? Use foo.ts or bar.ts?')).toEqual([
      'Should I bump to v1.2 or v2?',
      'Use foo.ts or bar.ts?',
    ]);
  });

  it('ignores "?" in code and URLs, and strips list markers', () => {
    const text = 'See https://x.dev/a?b=1 and `a ?? b`.\n```\nconst x = y ? 1 : 2;\n```\n- Which option do you want?';
    expect(questions(text)).toEqual(['Which option do you want?']);
  });

  it('splits sentences and keeps trailing quotes', () => {
    expect(questions('Done. Is "foo" fine?" Next steps! Ready (yes?)')).toEqual(['Is "foo" fine?"', 'Ready (yes?)']);
  });
});

describe('findLastCompletedAssistantMessage', () => {
  const msg = (role: string, stopReason: string, text: string) => ({
    type: 'message',
    message: { role, stopReason, content: [{ type: 'text', text }] },
  });
  const find = (branch: unknown[]) =>
    findLastCompletedAssistantMessage({ sessionManager: { getBranch: () => branch } } as never);

  it('skips incomplete replies', () => {
    expect(find([msg('assistant', 'stop', 'Old?'), msg('assistant', 'aborted', 'New?')])).toEqual({
      text: 'Old?',
      skippedIncomplete: true,
    });
    expect(find([msg('user', 'stop', 'hi')])).toEqual({ skippedIncomplete: false });
  });
});

it('buildAnswerMessage formats answers and fills blanks', () => {
  expect(buildAnswerMessage([{ question: 'A?', context: 'ctx' }, { question: 'B?' }], [' yes ', ''])).toBe(
    'Here are my answers to your questions:\n\nQ: A?\nContext: ctx\nA: yes\n\nQ: B?\nA: (no answer)',
  );
});

describe('AnswerComponent', () => {
  const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
  const make = () => {
    const done = vi.fn();
    const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 80 } } as unknown as TUI;
    const component = new AnswerComponent(
      [{ question: 'A?' }, { question: 'B?' }],
      tui,
      theme as unknown as Theme,
      done,
    );
    return { component, done };
  };
  const type = (component: AnswerComponent, text: string) => {
    for (const ch of text) component.handleInput(ch);
  };

  it('navigates with enter and submits after confirmation', () => {
    const { component, done } = make();
    type(component, 'pg');
    component.handleInput('\r');
    component.handleInput('\r');
    expect(component.render(80).join('\n')).toContain('1 unanswered item');
    expect(done).not.toHaveBeenCalled();
    component.handleInput('y');
    expect(done).toHaveBeenCalledWith(buildAnswerMessage([{ question: 'A?' }, { question: 'B?' }], ['pg', '']));
  });

  it('backs out of confirmation and cancels on escape', () => {
    const { component, done } = make();
    component.handleInput('\t');
    component.handleInput('\t');
    component.handleInput('n');
    expect(component.render(80).join('\n')).toContain('Esc cancel');
    component.handleInput('\x1b');
    expect(done).toHaveBeenCalledWith(null);
  });
});

describe('answer command', () => {
  const setup = (overrides: Record<string, unknown>) => {
    let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
    const notify = vi.fn();
    const custom = vi.fn((factory: (...args: unknown[]) => unknown) => new Promise((r) => factory({}, {}, {}, r)));
    const complete = vi.fn();
    const ctx = {
      hasUI: true,
      mode: 'tui',
      model: { provider: 'session', id: 'current' },
      modelRegistry: { getAvailableOfType: async () => [], getApiKeyAndHeaders: async () => ({ ok: true }), complete },
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Which DB?' }] },
          },
        ],
      },
      ui: { notify, setStatus() {}, custom },
      ...overrides,
    } as unknown as ExtensionContext;
    answer({
      on() {},
      registerShortcut() {},
      registerCommand(_name: string, spec: { handler: typeof command }) {
        command = spec.handler;
      },
    } as unknown as ExtensionAPI);
    return { run: () => command('', ctx), notify, custom, complete };
  };

  it('refuses to run outside the TUI instead of crashing', async () => {
    const h = setup({ mode: 'rpc' });
    await h.run();
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('TUI'), 'error');
  });

  it('reports provider errors instead of falling back', async () => {
    const h = setup({});
    h.complete.mockResolvedValue({ stopReason: 'error', errorMessage: '401 unauthorized', content: [] });
    await h.run();
    expect(h.notify).toHaveBeenLastCalledWith('401 unauthorized', 'error');
  });
});
