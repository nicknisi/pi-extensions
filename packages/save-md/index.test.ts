import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import saveMarkdownExtension from './index.js';

type Handler = (args: string, ctx: unknown) => Promise<void>;

function setup(branch: unknown[]) {
  let handler: Handler | undefined;
  const pi = {
    registerCommand: (_name: string, options: { handler: Handler }) => {
      handler = options.handler;
    },
  };
  saveMarkdownExtension(pi as never);
  const cwd = mkdtempSync(join(tmpdir(), 'save-md-'));
  const notify = vi.fn();
  const ctx = {
    cwd,
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => branch },
    ui: { notify },
  };
  return { run: (args: string) => handler!(args, ctx), cwd, notify };
}

const assistant = (content: unknown[]) => ({ type: 'message', message: { role: 'assistant', content } });

describe('/save-md', () => {
  it('saves only text blocks with a trailing newline', async () => {
    const { run, cwd, notify } = setup([
      assistant([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: '# One' },
        { type: 'toolCall', id: 'x', name: 'y', arguments: {} },
        { type: 'text', text: 'two' },
      ]),
    ]);
    await run('notes');
    expect(readFileSync(join(cwd, 'notes.md'), 'utf8')).toBe('# One\n\ntwo\n');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Saved Markdown'), 'info');
  });

  it('falls back to an earlier assistant message when the latest has no text', async () => {
    const { run, cwd } = setup([
      assistant([{ type: 'text', text: 'answer' }]),
      assistant([{ type: 'toolCall', id: 'x', name: 'y', arguments: {} }]),
    ]);
    await run('out.md');
    expect(readFileSync(join(cwd, 'out.md'), 'utf8')).toBe('answer\n');
  });

  it('warns on an empty name', async () => {
    const { run, notify } = setup([assistant([{ type: 'text', text: 'a' }])]);
    await run('   ');
    expect(notify).toHaveBeenCalledWith('Usage: /save-md name', 'warning');
  });

  it('warns when no assistant message has text', async () => {
    const { run, cwd, notify } = setup([assistant([])]);
    await run('x');
    expect(notify).toHaveBeenCalledWith('No assistant response on this branch has Markdown text', 'warning');
    expect(existsSync(join(cwd, 'x.md'))).toBe(false);
  });

  it('does not overwrite an existing file', async () => {
    const { run, cwd, notify } = setup([assistant([{ type: 'text', text: 'new' }])]);
    writeFileSync(join(cwd, 'x.md'), 'old');
    await run('x');
    expect(readFileSync(join(cwd, 'x.md'), 'utf8')).toBe('old');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('File already exists'), 'error');
  });

  it('notifies instead of throwing on other write errors', async () => {
    const { run, notify } = setup([assistant([{ type: 'text', text: 'a' }])]);
    await expect(run('missing/dir/x')).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Failed to save'), 'error');
  });
});
