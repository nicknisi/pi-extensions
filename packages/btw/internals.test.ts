import type { Message } from '@earendil-works/pi-ai';
import type { SessionEntry, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildSideThread, BtwWindow, dropUnansweredToolCalls, forkSessionWithThread, shellQuote } from './index.js';

const assistant = (content: any[]): Message =>
  ({ role: 'assistant', content, stopReason: 'toolUse', timestamp: 0 }) as unknown as Message;

it('drops unanswered tool calls and assistant messages left empty', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    assistant([{ type: 'toolCall', id: 'a', name: 'read', arguments: {} }]),
    { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [], isError: false, timestamp: 0 },
    assistant([
      { type: 'text', text: 'working' },
      { type: 'toolCall', id: 'b', name: 'read', arguments: {} },
    ]),
    assistant([{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }]),
  ] as Message[];
  const out = dropUnansweredToolCalls(msgs);
  expect(out).toHaveLength(4);
  expect(out[1]).toBe(msgs[1]);
  expect((out[3] as any).content).toEqual([{ type: 'text', text: 'working' }]);
});

it('builds the side thread from the session projection, dropping legacy btw messages', () => {
  const messages = [
    { role: 'branchSummary', summary: 'explored X', fromId: 'x', timestamp: 0 },
    { role: 'custom', customType: 'btw-answer', content: 'old', display: true, timestamp: 0 },
    { role: 'custom', customType: 'other', content: 'note', display: true, timestamp: 0 },
    { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 0 },
  ];
  const thread = buildSideThread({ buildSessionProjection: () => ({ messages }) as any });
  const texts = thread.map((m) => JSON.stringify(m.content));
  expect(thread).toHaveLength(3);
  expect(texts[0]).toContain('explored X');
  expect(texts.join()).not.toContain('old');
  expect(texts[1]).toContain('note');
});

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeAssistant = (text: string) => assistant([{ type: 'text', text }]);
const branch = [
  { type: 'message', id: 'e1', parentId: null, timestamp: '', message: { role: 'user', content: 'a', timestamp: 0 } },
  { type: 'label', id: 'l1', parentId: 'e1', timestamp: '', targetId: 'e1', label: 'x' },
  { type: 'message', id: 'e2', parentId: 'l1', timestamp: '', message: { role: 'user', content: 'b', timestamp: 0 } },
] as unknown as SessionEntry[];

it('forks with a valid parentId chain, labels dropped and header fields set', () => {
  tmp = mkdtempSync(join(tmpdir(), 'btw-fork-'));
  const file = forkSessionWithThread(
    {
      getBranch: () => branch,
      getCwd: () => '/proj',
      getSessionDir: () => tmp!,
      getSessionFile: () => '/s/live.jsonl',
    },
    [{ question: 'why?', answer: 'because' }],
    makeAssistant,
  );
  expect(dirname(file)).toBe(tmp);
  const [header, ...entries] = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(header).toMatchObject({ type: 'session', cwd: '/proj', parentSession: '/s/live.jsonl' });
  expect(entries.some((e) => e.type === 'label')).toBe(false);
  let parent: string | null = null;
  for (const e of entries) {
    expect(e.parentId).toBe(parent);
    parent = e.id;
  }
  expect(entries.map((e) => e.type)).toEqual(['message', 'message', 'message', 'message', 'session_info']);
  expect(entries.at(-1).name).toBe('btw: why?');
});

it('forks in-memory sessions into the temp dir, not cwd', () => {
  const file = forkSessionWithThread(
    { getBranch: () => [], getCwd: () => '/proj', getSessionDir: () => '', getSessionFile: () => undefined },
    [{ question: 'q', answer: 'a' }],
    makeAssistant,
  );
  try {
    expect(dirname(file)).toBe(tmpdir());
  } finally {
    rmSync(file, { force: true });
  }
});

it('shell-quotes paths with quotes and spaces', () => {
  expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
});

function makeWindow() {
  const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
  const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
  const close = vi.fn();
  return { win: new BtwWindow(tui, theme, 'p/m', close), close };
}

it('cancel aborts the stream and restores the question; retry gets a fresh signal', () => {
  const { win } = makeWindow();
  const onAsk = vi.fn();
  win.onAsk = onAsk;
  win.beginStreaming('first');
  const first = win.signal!;
  win.append('partial');
  win.handleInput('\x1b');
  expect(first.aborted).toBe(true);
  // Enter resubmits the restored question.
  win.handleInput('\r');
  expect(onAsk).toHaveBeenCalledWith('first');
  win.beginStreaming('first');
  expect(win.signal!.aborted).toBe(false);
  win.completeTurn('done');
  expect(win.completedTurns).toEqual([{ question: 'first', answer: 'done' }]);
  win.dispose();
});

it('dispose aborts an in-flight request', () => {
  const { win } = makeWindow();
  win.beginStreaming('q');
  const signal = win.signal!;
  win.dispose();
  expect(signal.aborted).toBe(true);
});
