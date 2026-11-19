import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import handoff, { buildSessionChain, entriesToMessages, fitConversation, recentRequests } from './index.js';

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 });

describe('fitConversation', () => {
  it('keeps everything when it fits', () => {
    expect(fitConversation([user('a'), user('b')], 1000)).toBe('[User]: a\n\n[User]: b');
  });

  it('drops the oldest messages first and says how many', () => {
    const out = fitConversation([user('old'.repeat(50)), user('mid'), user('new')], 40);
    expect(out).toBe('[1 earlier messages omitted to fit the context window]\n\n[User]: mid\n\n[User]: new');
  });

  it('truncates a newest message bigger than the whole budget instead of returning nothing', () => {
    const out = fitConversation([user('old'), user('x'.repeat(500))], 100);
    expect(out.startsWith('[1 earlier messages omitted to fit the context window]\n\n[User]: xxx')).toBe(true);
    expect(out.endsWith('\u2026 [truncated]')).toBe(true);
    expect(fitConversation([user('x'.repeat(500))], 100)).not.toContain('omitted');
  });
});

describe('entriesToMessages', () => {
  it('keeps compaction, branch and custom messages the agent saw', () => {
    const base = { id: 'x', parentId: null, timestamp: '2024-01-01T00:00:00.000Z' };
    const entries = [
      { ...base, type: 'compaction', summary: 'compacted', firstKeptEntryId: 'a', tokensBefore: 10 },
      { ...base, type: 'branch_summary', summary: 'branched', fromId: 'b' },
      { ...base, type: 'custom_message', customType: 'note', content: 'custom text', display: true },
      { ...base, type: 'message', message: { role: 'user', content: 'hi', timestamp: 0 } },
      { ...base, type: 'model_change', provider: 'p', modelId: 'm' },
    ] as unknown as SessionEntry[];
    expect(entriesToMessages(entries).map((m) => m.role)).toEqual([
      'compactionSummary',
      'branchSummary',
      'custom',
      'user',
    ]);
  });
});

describe('buildSessionChain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-chain-'));
  const session = (name: string, parentSession?: string) => {
    const file = join(dir, name);
    writeFileSync(file, `${JSON.stringify({ type: 'session', parentSession })}\n{"type":"message"}\n`);
    return file;
  };

  it('follows parent headers and stops at a missing file', async () => {
    const missing = join(dir, 'missing.jsonl');
    const a = session('a.jsonl', missing);
    expect(await buildSessionChain('/cur.jsonl', a)).toEqual(['/cur.jsonl', a, missing]);
  });

  it('stops at a malformed header', async () => {
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, 'not json\n');
    const b = session('b.jsonl', bad);
    expect(await buildSessionChain(undefined, b)).toEqual([b, bad]);
  });

  it('stops on a cycle', async () => {
    const c1 = join(dir, 'c1.jsonl');
    const c2 = session('c2.jsonl', c1);
    session('c1.jsonl', c2);
    expect(await buildSessionChain(c1, c2)).toEqual([c1, c2]);
  });

  it('caps the depth', async () => {
    let prev: string | undefined;
    for (let i = 0; i < 30; i++) prev = session(`d${i}.jsonl`, prev);
    expect(await buildSessionChain(undefined, prev)).toHaveLength(20);
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
      on: vi.fn(),
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
      mode: 'tui',
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

type Complete = (model: unknown, request: unknown, options: { signal?: AbortSignal }) => Promise<unknown>;
type Component = { handleInput?: (data: string) => void; dispose?: () => void };
type Factory = (
  tui: unknown,
  theme: unknown,
  kb: unknown,
  done: (r: unknown) => void,
) => Component | Promise<Component>;

describe('/handoff generation outcomes', () => {
  initTheme('dark'); // BorderedLoader renders a key hint from Pi's global theme
  const textResponse = (text: string) => ({ stopReason: 'stop', content: [{ type: 'text', text }] });

  /** Mirrors pi's showExtensionCustom: runs the factory, resolves on the first done(), then disposes. */
  const runCustom = (factory: Factory, onComponent?: (c: Component) => void) =>
    new Promise<unknown>((resolve) => {
      let closed = false;
      let component: Component | undefined;
      const done = (result: unknown) => {
        if (closed) return;
        closed = true;
        resolve(result);
        component?.dispose?.();
      };
      const tui = { requestRender: () => {} };
      const theme = { fg: (_color: string, s: string) => s, bold: (s: string) => s };
      void Promise.resolve(factory(tui, theme, undefined, done)).then((c) => {
        component = c;
        if (closed) c.dispose?.();
        else onComponent?.(c);
      });
    });

  const setup = (
    mode: string,
    opts: {
      complete?: Complete;
      custom?: () => Promise<unknown>;
      onComponent?: (c: Component) => void;
    } = {},
  ) => {
    let handler!: Handler;
    handoff({
      registerCommand: (_name: string, c: { handler: Handler }) => (handler = c.handler),
      on: () => {},
    } as unknown as ExtensionAPI);
    const complete = vi.fn<Complete>(opts.complete ?? (async () => textResponse('RPC prompt')));
    const ctx = {
      mode,
      hasUI: true,
      model: { provider: 'p', id: 'm' },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }), complete },
      sessionManager: {
        getBranch: () => [{ type: 'message', message: { role: 'user', content: 'hi', timestamp: 0 } }],
        getSessionFile: () => undefined,
        getHeader: () => ({}),
      },
      ui: {
        notify: vi.fn(),
        custom: vi.fn(opts.custom ?? ((factory: Factory) => runCustom(factory, opts.onComponent))),
        editor: vi.fn(async () => undefined),
      },
      newSession: vi.fn(),
    } as unknown as ExtensionCommandContext & {
      ui: { notify: ReturnType<typeof vi.fn>; editor: ReturnType<typeof vi.fn>; custom: ReturnType<typeof vi.fn> };
    };
    return { run: () => handler('goal', ctx), ctx, complete };
  };

  it('runs generation through the loader and opens the editor with the result', async () => {
    const { run, ctx, complete } = setup('tui', { complete: async () => textResponse('TUI prompt') });
    await run();
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal);
    expect(ctx.ui.editor).toHaveBeenCalledWith('Edit handoff prompt', expect.stringContaining('TUI prompt'));
  });

  it('cancels when the loader is aborted', async () => {
    let signal: AbortSignal | undefined;
    const { run, ctx } = setup('tui', {
      // Never settles on its own; only the abort ends it, like a real in-flight request.
      complete: (_m, _r, options) =>
        new Promise((resolve) => {
          signal = options.signal;
          signal?.addEventListener('abort', () => resolve({ stopReason: 'aborted', content: [] }));
        }),
      onComponent: (c) => c.handleInput?.('\x1b'),
    });
    await run();
    expect(signal?.aborted).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith('Cancelled', 'info');
    expect(ctx.ui.editor).not.toHaveBeenCalled();
  });

  it('reports generation errors', async () => {
    const { run, ctx } = setup('tui', {
      complete: async () => ({ stopReason: 'error', errorMessage: 'boom', content: [] }),
    });
    await run();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Handoff failed: boom', 'error');
    expect(ctx.ui.editor).not.toHaveBeenCalled();
  });

  it('reports a rejected completion instead of hanging', async () => {
    const { run, ctx } = setup('tui', {
      complete: async () => {
        throw new Error('network down');
      },
    });
    await run();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Handoff failed: network down', 'error');
    expect(ctx.ui.editor).not.toHaveBeenCalled();
  });

  it('reports an empty response', async () => {
    const { run, ctx } = setup('tui', { complete: async () => ({ stopReason: 'stop', content: [] }) });
    await run();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Handoff failed: No text in response'), 'error');
    expect(ctx.ui.editor).not.toHaveBeenCalled();
  });

  it('treats an undefined custom() result as cancelled instead of crashing', async () => {
    const { run, ctx } = setup('tui', { custom: async () => undefined });
    await run();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Cancelled', 'info');
  });

  it('generates without custom() in RPC mode and cancels when the editor is dismissed', async () => {
    const { run, ctx } = setup('rpc');
    await run();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.editor).toHaveBeenCalledWith('Edit handoff prompt', expect.stringContaining('RPC prompt'));
    expect(ctx.ui.notify).toHaveBeenLastCalledWith('Cancelled', 'info');
    expect(ctx.newSession).not.toHaveBeenCalled();
  });
});
