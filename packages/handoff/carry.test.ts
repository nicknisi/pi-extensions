import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { CARRIED_INPUTS_TYPE, carriedInputs } from './carry.js';
import handoff from './index.js';

const msg = (id: string, role: string, text: string, extra: object = {}) =>
  ({
    type: 'message',
    id,
    parentId: null,
    timestamp: '',
    message: { role, content: [{ type: 'text', text }], timestamp: 0, ...extra },
  }) as unknown as SessionEntry;
const user = (id: string, text: string) => msg(id, 'user', text);
const reply = (id: string) => msg(id, 'assistant', `reply ${id}`);
const answer = (id: string, text: string, toolName = 'ask_user_question') =>
  msg(id, 'toolResult', text, { toolName, toolCallId: 'c', isError: false });

describe('carriedInputs', () => {
  it('carries user messages and question answers from before the kept boundary, verbatim and in order', () => {
    const branch = [
      user('u1', "Rules: don't push."),
      reply('a1'),
      answer('t1', 'User answered: Spend up to $10'),
      answer('t2', 'other tool output', 'bash'),
      user('u2', 'continue'),
      user('kept', 'already in context'),
    ];
    const out = carriedInputs(branch, 'kept')!;
    expect(out).toContain('verbatim: 3 of 3.');
    expect(out.indexOf("--- user (entry u1) ---\nRules: don't push.")).toBeGreaterThan(-1);
    expect(
      out.indexOf('--- answer to ask_user_question (entry t1) ---\nUser answered: Spend up to $10'),
    ).toBeGreaterThan(out.indexOf('entry u1'));
    expect(out.indexOf('entry u2')).toBeGreaterThan(out.indexOf('entry t1'));
    expect(out).not.toContain('already in context');
    expect(out).not.toContain('other tool output');
    expect(out).not.toContain('reply a1');
  });

  it('always keeps the first message, then fills newest-first and says how many were left out', () => {
    const branch = [
      user('first', `RULES ${'r'.repeat(5000)}`),
      ...Array.from({ length: 12 }, (_, i) => user(`m${i}`, `${i} ${'x'.repeat(1990)}`)),
      user('kept', 'k'),
    ];
    const out = carriedInputs(branch, 'kept', '/s.jsonl')!;
    expect(out).toContain('entry first');
    expect(out).toContain('entry m11');
    expect(out).not.toContain('entry m0 ');
    expect(out).toMatch(/older ones omitted\. Their full text is in \/s\.jsonl\./);
    expect(out.indexOf('entry first')).toBeLessThan(out.indexOf('entry m11'));
  });

  it('caps the first message at 6,000 characters and others at 2,000', () => {
    const out = carriedInputs([user('f', 'a'.repeat(7000)), user('n', 'b'.repeat(3000)), user('kept', 'k')], 'kept')!;
    expect(out).toContain(`${'a'.repeat(6000)}… [truncated]`);
    expect(out).not.toContain('a'.repeat(6001));
    expect(out).toContain(`${'b'.repeat(2000)}… [truncated]`);
  });

  it('includes everything before a retain-none compaction, whose kept id is its own', () => {
    const branch = [user('u1', 'hello'), { type: 'compaction', id: 'c1' } as SessionEntry];
    expect(carriedInputs(branch, 'c1')).toContain('entry u1');
  });

  it('carries nothing when the boundary is unknown or the span had no user input', () => {
    expect(carriedInputs([user('u1', 'x')], 'missing')).toBeUndefined();
    expect(carriedInputs([reply('a1'), user('kept', 'k')], 'kept')).toBeUndefined();
  });
});

describe('session_compact hook', () => {
  function setup(branch: SessionEntry[]) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const sendMessage = vi.fn();
    handoff({
      registerCommand: vi.fn(),
      on: (name: string, h: never) => handlers.set(name, h),
      sendMessage,
    } as never as ExtensionAPI);
    const ctx = { sessionManager: { getBranch: () => branch, getSessionFile: () => '/s.jsonl' } };
    handlers.get('session_compact')!({ compactionEntry: { firstKeptEntryId: 'kept' } }, ctx);
    return sendMessage;
  }

  it('posts the carried words as a hidden message', () => {
    const sendMessage = setup([user('u1', "don't push"), user('kept', 'k')]);
    expect(sendMessage).toHaveBeenCalledWith({
      customType: CARRIED_INPUTS_TYPE,
      content: expect.stringContaining("don't push"),
      display: false,
    });
  });

  it('posts nothing when there is nothing to carry', () => {
    expect(setup([reply('a1'), user('kept', 'k')])).not.toHaveBeenCalled();
  });
});
