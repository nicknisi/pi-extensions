import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import handoff, { fitConversation, recentRequests } from './index.js';

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 });

describe('fitConversation', () => {
  it('keeps everything when it fits', () => {
    expect(fitConversation([user('a'), user('b')], 1000)).toBe('[User]: a\n\n[User]: b');
  });

  it('drops the oldest messages first and says how many', () => {
    const out = fitConversation([user('old'.repeat(50)), user('mid'), user('new')], 40);
    expect(out).toBe('[1 earlier messages omitted to fit the context window]\n\n[User]: mid\n\n[User]: new');
  });
});

describe('recentRequests', () => {
  it('returns the last five user texts verbatim, skipping other roles and empty content', () => {
    const msgs = [
      ...['1', '2', '3', '4', '5', '6'].map((t) => ({ role: 'user', content: t })),
      { role: 'assistant', content: [{ type: 'text', text: 'nope' }] },
      { role: 'user', content: [{ type: 'image' }] },
    ];
    expect(recentRequests(msgs)).toEqual(['2', '3', '4', '5', '6']);
  });

  it('reads text parts and truncates long requests', () => {
    const [r] = recentRequests([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2500) }] }]);
    expect(r).toBe(`${'x'.repeat(2000)}\u2026 [truncated]`);
  });
});

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

describe('/handoff', () => {
  it('puts the edited prompt into the new session through its fresh ctx, never the stale one', async () => {
    let handler!: Handler;
    handoff({
      registerCommand: (_name: string, c: { handler: Handler }) => (handler = c.handler),
    } as unknown as ExtensionAPI);

    // pi throws on any use of the old ctx after the session is replaced.
    let replaced = false;
    const live =
      <T extends unknown[]>(fn: (...args: T) => unknown) =>
      (...args: T) => {
        if (replaced) throw new Error('This extension ctx is stale after session replacement');
        return fn(...args);
      };
    const newCtx = { ui: { setEditorText: vi.fn(), notify: vi.fn() } };
    const ctx = {
      hasUI: true,
      model: { provider: 'p', id: 'm' },
      sessionManager: {
        getBranch: () => [{ type: 'message', message: { role: 'user', content: 'hi', timestamp: 0 } }],
        getSessionFile: () => '/tmp/parent.jsonl',
        getHeader: () => ({}),
      },
      ui: {
        notify: live(vi.fn()),
        setEditorText: live(vi.fn()),
        custom: live(async () => ({ text: 'Generated prompt' })),
        editor: live(async (_title: string, text: string) => `${text} (edited)`),
      },
      newSession: vi.fn(async (options: { withSession?: (c: unknown) => Promise<void> }) => {
        replaced = true;
        await options.withSession?.(newCtx);
        return { cancelled: false };
      }),
    } as unknown as ExtensionCommandContext;

    await handler('do the next thing', ctx);

    expect(ctx.newSession).toHaveBeenCalledWith(expect.objectContaining({ parentSession: '/tmp/parent.jsonl' }));
    expect(newCtx.ui.setEditorText).toHaveBeenCalledWith(expect.stringContaining('Generated prompt'));
    expect(newCtx.ui.setEditorText).toHaveBeenCalledWith(expect.stringContaining('(edited)'));
    const draft = String(newCtx.ui.setEditorText.mock.calls[0]?.[0]);
    expect(draft).toContain('## My Recent Requests (verbatim)\n> hi');
    expect(draft).toContain('Check git status');
    expect(draft).toContain('rg or grep');
  });
});
