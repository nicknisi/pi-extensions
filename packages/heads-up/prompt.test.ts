import { describe, expect, it } from 'vitest';
import { checkPrompt, digest } from './prompt.js';

const msg = (message: unknown) => ({ type: 'message', message });

describe('digest', () => {
  const entries = [
    { type: 'compaction', summary: 'Set up the repo.' },
    msg({ role: 'user', content: 'Add caching' }),
    msg({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Adding a cache.' },
        { type: 'toolCall', name: 'edit', arguments: { path: 'a.ts' } },
      ],
    }),
    msg({ role: 'toolResult', toolName: 'edit', isError: true, content: [{ type: 'text', text: 'x'.repeat(1000) }] }),
    msg({ role: 'bashExecution', command: 'ls', output: 'a.ts', excludeFromContext: false }),
    msg({ role: 'bashExecution', command: 'secret', output: 'no', excludeFromContext: true }),
    { type: 'label', label: 'ignored' },
  ];

  it('serializes text, tool calls, and truncated results', () => {
    const out = digest(entries, 100_000);
    expect(out).toContain('[Summary of earlier work]\nSet up the repo.');
    expect(out).toContain('User: Add caching');
    expect(out).toContain('Assistant: Adding a cache.\nTool call edit: {"path":"a.ts"}');
    expect(out).toContain('Tool result (edit) [error]: ');
    expect(out).toContain('[600 more chars]');
    expect(out).toContain('User ran: ls');
    expect(out).not.toContain('secret');
  });

  it('keeps the most recent sections within budget', () => {
    const out = digest(entries, 60);
    expect(out.startsWith('[Earlier conversation omitted]')).toBe(true);
    expect(out).toContain('User ran: ls');
    expect(out).not.toContain('Add caching');
  });
});

describe('checkPrompt', () => {
  it('lists offered and known topics to skip', () => {
    const out = checkPrompt('User: hi', ['old offer'], ['known topic']);
    expect(out).toContain('<session>\nUser: hi\n</session>');
    expect(out).toContain('- old offer');
    expect(out).toContain('- known topic');
  });

  it('omits empty skip lists', () => {
    expect(checkPrompt('User: hi', [], [])).not.toContain('skip');
  });
});
