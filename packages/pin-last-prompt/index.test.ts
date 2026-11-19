import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import pinLastPrompt, { collectPrompts, stickyEntry, type PromptEntry } from './index.js';

// Fakes named like pi's transcript classes: collectPrompts matches on constructor.name.
class Container {
  constructor(public children: unknown[]) {}
  render(width: number): string[] {
    return this.children.flatMap((c) => (c as { render(w: number): string[] }).render(width));
  }
}
class UserMessageComponent {
  constructor(
    public text: string,
    private lines: number,
  ) {}
  render(): string[] {
    return Array.from({ length: this.lines }, () => 'u');
  }
}
class Block {
  constructor(private lines: number) {}
  render(): string[] {
    return Array.from({ length: this.lines }, () => 'b');
  }
}

describe('collectPrompts', () => {
  it('accumulates line offsets through nested Containers', () => {
    const tree = [
      new Block(2), // header
      new Container([new UserMessageComponent('first\n  prompt', 3), new Block(4)]),
      new Container([new Container([new Block(1), new UserMessageComponent('second', 2)])]),
      new Block(5),
    ];
    const out: PromptEntry[] = [];
    const total = collectPrompts(tree, 80, 0, out);
    expect(out).toEqual([
      { start: 2, text: 'first prompt' },
      { start: 10, text: 'second' },
    ]);
    expect(total).toBe(17);
  });

  it('does not recurse into non-Container components', () => {
    class Box extends Block {
      children = [new UserMessageComponent('hidden', 1)];
    }
    const out: PromptEntry[] = [];
    expect(collectPrompts([new Box(3)], 80, 0, out)).toBe(3);
    expect(out).toEqual([]);
  });
});

describe('stickyEntry', () => {
  const entries = [
    { start: 5, text: 'a' },
    { start: 20, text: 'b' },
    { start: 40, text: 'c' },
  ];
  it('clamps to the first prompt above it', () => expect(stickyEntry(entries, 0)?.text).toBe('a'));
  it('picks the last entry with start <= scrollTop', () => {
    expect(stickyEntry(entries, 5)?.text).toBe('a');
    expect(stickyEntry(entries, 39)?.text).toBe('b');
    expect(stickyEntry(entries, 40)?.text).toBe('c');
    expect(stickyEntry(entries, 999)?.text).toBe('c');
  });
  it('returns undefined with no entries', () => expect(stickyEntry([], 10)).toBeUndefined());
});

describe('widget lifecycle', () => {
  it('does not show the overlay if disposed before the queued sync runs', async () => {
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
    const pi = { on: (name: string, fn: never) => (handlers[name] = fn) } as unknown as ExtensionAPI;
    pinLastPrompt(pi);

    let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
    const ctx = { mode: 'tui', ui: { setWidget: (_id: string, f: typeof factory) => (factory = f) } };
    await handlers.session_start!({}, ctx);
    await handlers.before_agent_start!({ prompt: 'hello' }, ctx);

    const showOverlay = vi.fn(() => ({ hide: vi.fn() }));
    const tui = {
      mode: 'fullscreen',
      isFollowingOutput: false,
      terminal: { columns: 80 },
      getPrimaryScrollView: () => undefined, // falls back to lastPrompt
      showOverlay,
      requestRender: vi.fn(),
    };
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
    const widget = factory!(tui, theme) as { render(w: number): string[]; dispose(): void };

    widget.render(80); // queues the overlay show
    widget.dispose();
    await Promise.resolve();
    expect(showOverlay).not.toHaveBeenCalled();

    const live = factory!(tui, theme) as { render(w: number): string[] };
    live.render(80);
    await Promise.resolve();
    expect(showOverlay).toHaveBeenCalledOnce();
  });
});
