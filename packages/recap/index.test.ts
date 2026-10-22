import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import recap from './index.js';

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

type BranchEntry = { type: string; [key: string]: unknown };

function messages(count: number): BranchEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'message',
    message: {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message ${index}` }],
    },
  }));
}

// Link entries into a parent chain, as pi's session tree does.
function chain(entries: BranchEntry[]) {
  return entries.map((entry, index) => ({
    id: `e${index}`,
    parentId: index === 0 ? null : `e${index - 1}`,
    timestamp: new Date(0).toISOString(),
    ...entry,
  }));
}

function promptText(complete: ReturnType<typeof harness>['complete']): string {
  const context = complete.mock.calls[0]![1];
  const content = context.messages[0]!.content as { text: string }[];
  return content[0]!.text;
}

function harness(entries: BranchEntry[] = messages(4)) {
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
  const branch = chain(entries);
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

let agentDir: string;

beforeEach(() => {
  // Hermetic: never read the real ~/.pi/agent/configs/recap.json.
  agentDir = mkdtempSync(join(tmpdir(), 'recap-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

async function idleTick(ctx: ExtensionContext, handlers: Map<string, EventHandler>) {
  await handlers.get('session_start')!({}, ctx);
  await vi.advanceTimersByTimeAsync(180_000);
  await handlers.get('session_shutdown')!({}, ctx);
}

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

  it('summarizes the compacted context, not history before compaction', async () => {
    const { commands, complete, ctx } = harness([
      { type: 'message', message: { role: 'user', content: 'old pre-compaction message' } },
      { type: 'compaction', summary: 'compacted summary text', firstKeptEntryId: 'e2', tokensBefore: 1 },
      ...messages(2),
    ]);
    complete.mockResolvedValue({ content: [{ type: 'text', text: 'r' }] } as AssistantMessage);

    await commands.get('recap')!('', ctx);

    const text = promptText(complete);
    expect(text).toContain('compacted summary text');
    expect(text).toContain('message 1');
    expect(text).not.toContain('old pre-compaction message');
  });

  it('caps tool call arguments in the transcript', async () => {
    const body = 'x'.repeat(5_000);
    const { commands, complete, ctx } = harness([
      { type: 'message', message: { role: 'user', content: 'write it' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'a.ts', content: body } }],
        },
      },
    ]);
    complete.mockResolvedValue({ content: [{ type: 'text', text: 'r' }] } as AssistantMessage);

    await commands.get('recap')!('', ctx);

    const text = promptText(complete);
    expect(text).toContain('Tool write called with {"path":"a.ts"');
    expect(text).not.toContain(body);
    expect(text.length).toBeLessThan(1_000);
  });

  it('does not re-fire when the branch already ends with a recap', async () => {
    const { complete, ctx, handlers } = harness([
      ...messages(4),
      { type: 'custom', customType: 'recap', data: { summary: 'earlier', ts: 0 } },
      { type: 'label', targetId: 'e0', label: 'x' },
    ]);
    complete.mockResolvedValue({ content: [{ type: 'text', text: 'r' }] } as AssistantMessage);

    await idleTick(ctx, handlers);

    expect(complete).not.toHaveBeenCalled();
  });

  it('counts only message entries toward the minimum branch length', async () => {
    const { complete, ctx, handlers } = harness([
      { type: 'model_change', provider: 'p', modelId: 'm' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      ...messages(2),
    ]);
    complete.mockResolvedValue({ content: [{ type: 'text', text: 'r' }] } as AssistantMessage);

    await idleTick(ctx, handlers);

    expect(complete).not.toHaveBeenCalled();
  });
});
