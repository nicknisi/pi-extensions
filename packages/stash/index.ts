/**
 * Message Stash Extension
 *
 * Replicates Claude Code's message stash: press ctrl+s to stash
 * whatever you've typed in the input box, do something else, then press
 * ctrl+s again (with an empty input) to restore it.
 *
 * - ctrl+s with text in the editor → pushes it onto a stack and clears
 * - ctrl+s with an empty editor   → pops the most recent stash back
 * - sending another message        → auto-restores this session's most recent stash
 *
 * Stashes are saved per working directory under the agent dir, so they
 * survive /reload, restarts and new sessions. A widget above the editor shows
 * how many drafts are stashed with a one-line preview of the most recent one.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

const WIDGET_KEY = 'message-stash';
/** Oldest drafts beyond this are dropped. */
export const MAX_DRAFTS = 10;

interface Draft {
  text: string;
  /** Session that stashed it; only that session auto-restores it. */
  session: string;
}

export function stashFile(cwd: string): string {
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return join(getAgentDir(), 'stash', `${key}.json`);
}

/** Drafts for a directory, oldest first. Throws on an unreadable file so it is never overwritten. */
function load(cwd: string): Draft[] {
  let raw: string;
  try {
    raw = readFileSync(stashFile(cwd), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const drafts: unknown = JSON.parse(raw);
  if (!Array.isArray(drafts) || !drafts.every((d) => typeof d?.text === 'string' && typeof d?.session === 'string')) {
    throw new Error(`Invalid stash file: ${stashFile(cwd)}`);
  }
  return drafts;
}

/**
 * Re-read, change and atomically rewrite a directory's drafts.
 * shortcut: no cross-process lock; two windows stashing in the same instant can drop one draft. Add a lock if that shows up.
 */
function update(cwd: string, change: (drafts: Draft[]) => Draft[]): Draft[] {
  const drafts = change(load(cwd));
  const file = stashFile(cwd);
  const tmp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(join(getAgentDir(), 'stash'), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(drafts), { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return drafts;
}

/** Copy of drafts without the newest one that matches. */
function withoutNewest(drafts: Draft[], match: (draft: Draft) => boolean): Draft[] {
  for (let i = drafts.length - 1; i >= 0; i--) {
    if (match(drafts[i]!)) return [...drafts.slice(0, i), ...drafts.slice(i + 1)];
  }
  return drafts;
}

const isDraft = (draft: Draft) => (other: Draft) => other.text === draft.text && other.session === draft.session;

/** First line of a draft, with control characters (ESC, BEL, …) removed, for the widget. */
export function preview(text: string, max = 60): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\p{Cc}/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export default function stash(pi: ExtensionAPI) {
  const updateWidget = (ctx: ExtensionContext, drafts: Draft[]) => {
    if (drafts.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const theme = ctx.ui.theme;
    const count = drafts.length > 1 ? theme.fg('dim', ` (+${drafts.length - 1} more)`) : '';
    ctx.ui.setWidget(WIDGET_KEY, [
      `${theme.fg('accent', '⧉ stashed:')} ${theme.fg('muted', preview(drafts.at(-1)!.text))}${count} ${theme.fg('dim', '· ctrl+s to restore')}`,
    ]);
  };

  /** Run a stash change; a failure is reported and leaves the editor untouched. */
  const run = (ctx: ExtensionContext, action: () => void) => {
    try {
      action();
    } catch (error) {
      ctx.ui.notify(`Stash failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI) run(ctx, () => updateWidget(ctx, load(ctx.cwd)));
  });

  pi.registerShortcut('ctrl+s', {
    description: 'Stash / restore the typed message',
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      run(ctx, () => {
        const text = ctx.ui.getEditorText();
        if (text.trim().length > 0) {
          const session = ctx.sessionManager.getSessionId();
          const drafts = update(ctx.cwd, (current) => [...current, { text, session }].slice(-MAX_DRAFTS));
          // Clear only after the draft is safely on disk.
          ctx.ui.setEditorText('');
          updateWidget(ctx, drafts);
          return;
        }
        const restored = load(ctx.cwd).at(-1);
        if (!restored) return;
        // Re-read inside update: another window may have changed the stack meanwhile.
        const drafts = update(ctx.cwd, (current) => withoutNewest(current, isDraft(restored)));
        ctx.ui.setEditorText(restored.text);
        updateWidget(ctx, drafts);
      });
    },
  });

  // After a message is submitted, auto-restore this session's most recent
  // stash into the now-empty editor (mirrors Claude Code's behavior). Drafts
  // stashed by other windows stay put until restored with ctrl+s.
  pi.on('before_agent_start', async (_event, ctx) => {
    if (!ctx.hasUI || ctx.ui.getEditorText().trim().length > 0) return;
    run(ctx, () => {
      const session = ctx.sessionManager.getSessionId();
      const restored = [...load(ctx.cwd)].reverse().find((draft) => draft.session === session);
      if (!restored) return;
      const drafts = update(ctx.cwd, (current) => withoutNewest(current, isDraft(restored)));
      ctx.ui.setEditorText(restored.text);
      updateWidget(ctx, drafts);
    });
  });
}
