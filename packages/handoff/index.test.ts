import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import handoff from './index.js';

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
  });
});
