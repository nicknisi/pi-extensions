import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sound = vi.hoisted(() => ({
  speakDone: null as (() => void) | null,
  clicks: [] as number[],
}));

vi.mock('./sound.js', () => ({
  playTone: () => null,
  playNoise: () => null,
  playFanfare: () => null,
  playWhoosh: () => null,
  playClick: () => {
    sound.clicks.push(Date.now());
    return null;
  },
  speak: (_text: string, _rate: number, onDone?: () => void) => {
    sound.speakDone = onDone ?? null;
    return null;
  },
  killProc: () => {},
}));

const { default: mg } = await import('./index.js');

interface Component {
  render(width: number): string[];
  dispose(): void;
}

let component: Component | null = null;
let closed = false;

async function start(name = 'Nick'): Promise<Component> {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  mg({
    registerCommand: (_name: string, opts: { handler: typeof handler }) => {
      handler = opts.handler;
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: 'tui',
    ui: {
      notify: () => {},
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => Component) => {
        component = factory({ requestRender: () => {} }, {}, {}, () => {
          closed = true;
        });
        return Promise.resolve();
      },
    },
  };
  await handler!(name, ctx);
  return component!;
}

/** Advance the fake clock to an absolute elapsed time since the animation started. */
function advanceTo(ms: number): void {
  vi.advanceTimersByTime(ms - (Date.now() - startedAt));
}

const isFinale = (lines: string[]) => lines.some((l) => l.includes('C O M P L E T E'));
const hasText = (lines: string[], text: string) => lines.some((l) => l.includes(text));

let startedAt = 0;

beforeEach(() => {
  vi.useFakeTimers();
  startedAt = Date.now();
  sound.speakDone = null;
  sound.clicks = [];
  closed = false;
});

afterEach(() => {
  component?.dispose();
  component = null;
  vi.useRealTimers();
});

describe('/mg phase timing', () => {
  it('runs the departure for its full duration after speech actually ends', async () => {
    const c = await start();
    advanceTo(28_500);
    expect(sound.speakDone).toBeTypeOf('function');
    sound.speakDone!();

    advanceTo(29_000);
    const early = c.render(100);
    expect(isFinale(early)).toBe(false);
    expect(hasText(early, 'thank you')).toBe(false);

    // Same flap frame (t % 1000), later progress: the flyer must have moved.
    advanceTo(32_000);
    const late = c.render(100);
    expect(isFinale(late)).toBe(false);
    expect(late).not.toEqual(early);

    advanceTo(33_600);
    expect(isFinale(c.render(100))).toBe(true);

    advanceTo(38_400);
    expect(closed).toBe(false);
    advanceTo(38_600);
    expect(closed).toBe(true);
  });

  it('shows every subtitle, including the last, when speech never reports completion', async () => {
    const c = await start();
    advanceTo(6_500 + 18_900);
    expect(hasText(c.render(200), 'Goodbye, Nick. And thank you.')).toBe(true);
    advanceTo(6_500 + 23_900);
    expect(hasText(c.render(200), 'thank you')).toBe(true);
    advanceTo(6_500 + 24_100);
    expect(hasText(c.render(200), 'thank you')).toBe(false);
  });

  it('accelerates the MDR clicks as the bar fills', async () => {
    await start();
    advanceTo(2_600);
    const gaps = sound.clicks.slice(1).map((t, i) => t - sound.clicks[i]!);
    expect(gaps.length).toBeGreaterThan(4);
    expect(gaps.at(-1)!).toBeLessThan(gaps[0]!);
  });
});

describe('/mg render width', () => {
  it('never renders a line wider than the terminal, in any phase', async () => {
    const c = await start('A-very-long-user-supplied-name-that-goes-on-and-on-and-on');
    for (let t = 0; t < 41_000; t += 500) {
      advanceTo(t);
      if (closed) break;
      for (const width of [1, 10, 19, 30, 60, 100]) {
        for (const line of c.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
