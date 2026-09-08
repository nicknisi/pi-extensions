import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import stash from './index.js';

it('stashes and restores drafts with Ctrl+Shift+S and shows the matching hint', async () => {
  const registerShortcut = vi.fn<ExtensionAPI['registerShortcut']>();
  stash({ registerShortcut, on: vi.fn() } as unknown as ExtensionAPI);

  expect(registerShortcut).toHaveBeenCalledOnce();
  const [key, { handler }] = registerShortcut.mock.calls[0]!;
  expect(key).toBe('ctrl+shift+s');

  let text = 'first draft';
  const setWidget = vi.fn();
  const ctx = {
    hasUI: true,
    ui: {
      getEditorText: () => text,
      setEditorText: (value: string) => {
        text = value;
      },
      setWidget,
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionContext;

  await handler(ctx);
  expect(text).toBe('');
  expect(setWidget).toHaveBeenLastCalledWith('message-stash', [expect.stringContaining('ctrl+shift+s to restore')]);

  text = 'second draft';
  await handler(ctx);
  expect(text).toBe('');
  await handler(ctx);
  expect(text).toBe('second draft');
  text = '';
  await handler(ctx);
  expect(text).toBe('first draft');
  expect(setWidget).toHaveBeenLastCalledWith('message-stash', undefined);
});
