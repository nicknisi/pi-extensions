import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import recap from './index.js';

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

function harness() {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const appendEntry = vi.fn();
  const notify = vi.fn();
  const model = {
    provider: 'custom-provider',
    id: 'custom-model',
    api: 'custom-stream-api',
  } as Model<Api>;
  const complete = vi.fn<ExtensionContext['modelRegistry']['complete']>();
  const branch = Array.from({ length: 4 }, (_, index) => ({
    type: 'message',
    message: {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message ${index}` }],
    },
  }));
  const pi = {
    appendEntry,
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
    registerEntryRenderer() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'tui',
    model,
    isIdle: () => true,
    modelRegistry: { complete, find: () => undefined },
    sessionManager: { getBranch: () => branch },
    ui: { notify },
  } as unknown as ExtensionContext;

  recap(pi);
  return { appendEntry, commands, complete, ctx, handlers, model, notify };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('recap extension', () => {
  it('completes custom-provider models through the model registry', async () => {
    const { appendEntry, commands, complete, ctx, model } = harness();
    complete.mockResolvedValue({
      content: [{ type: 'text', text: 'Current recap' }],
    } as AssistantMessage);

    await commands.get('recap')!('', ctx);

    expect(complete).toHaveBeenCalledWith(model, expect.any(Object), expect.any(Object));
    expect(appendEntry).toHaveBeenCalledWith('recap', expect.objectContaining({ summary: 'Current recap' }));
  });

  it('reports background recap failures without an unhandled rejection', async () => {
    const { complete, ctx, handlers, notify } = harness();
    complete.mockRejectedValue(new Error('provider unavailable'));

    await handlers.get('session_start')!({}, ctx);
    await vi.advanceTimersByTimeAsync(180_000);

    expect(notify).toHaveBeenCalledWith('recap: provider unavailable', 'warning');
    await handlers.get('session_shutdown')!({}, ctx);
  });
});
