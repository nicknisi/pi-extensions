import { describe, expect, it, vi } from 'vitest';
import claudeDesignExtension from './index.js';

// Never open a real browser.
vi.mock('node:child_process', () => ({
  spawn: () => ({
    on() {
      return this;
    },
    unref() {},
  }),
}));

describe('/design-login', () => {
  it('reports the code paste as a login (blockedKind auth)', async () => {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    claudeDesignExtension({ registerCommand: (name: string, command: never) => commands.set(name, command) } as never);
    const input = vi.fn(async () => undefined);

    await commands.get('design-login')!.handler('', { ui: { input, notify: vi.fn() } });

    expect(input).toHaveBeenCalledWith(expect.stringContaining('CODE#STATE'), 'CODE#STATE', { blockedKind: 'auth' });
  });
});
