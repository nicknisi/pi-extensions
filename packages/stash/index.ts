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
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

interface StoredDraft extends Draft {
  file: string;
}

/**
 * One file per draft, so no file is ever rewritten and no lock is needed:
 * stashing creates a file, and restoring claims one by deleting it, which only
 * one window can do.
 */
export function stashDir(cwd: string): string {
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return join(getAgentDir(), 'stash', key);
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Saved drafts, oldest first. A draft file that can't be read is skipped and left alone. */
function list(cwd: string): StoredDraft[] {
  const dir = stashDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const drafts: StoredDraft[] = [];
  for (const name of names.sort()) {
    try {
      const draft = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (typeof draft?.text === 'string' && typeof draft?.session === 'string') {
        drafts.push({ text: draft.text, session: draft.session, file: join(dir, name) });
      }
    } catch {
      // Claimed by another window meanwhile, or unreadable; never touch it.
    }
  }
  return drafts;
}

/** Best-effort fsync of a directory, so a rename or delete in it survives a power loss. */
function syncDir(dir: string): void {
  if (process.platform === 'win32') return; // Windows can't open a directory
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // The draft itself is already safe; this only hardens it against power loss.
  }
}

/** Last timestamp used for a draft name in this process; keeps same-millisecond saves in order. */
let lastStamp = 0;

/** Save a draft durably. Once this returns, the draft is on disk; nothing after the rename can throw. */
function add(cwd: string, draft: Draft): void {
  const dir = stashDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Names sort by stash time. The stamp never repeats within a process, and the UUID keeps windows apart.
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  const name = `${String(lastStamp).padStart(16, '0')}-${randomUUID()}`;
  const tmp = join(dir, `${name}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(draft));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(dir, `${name}.json`));
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  syncDir(dir);
}

/** Drop drafts beyond the cap, oldest first. Best effort: the new draft is already saved. */
function trim(cwd: string): void {
  try {
    for (const draft of list(cwd).slice(0, -MAX_DRAFTS)) unlinkSync(draft.file);
  } catch {
    // Another window trimmed the same draft, or the folder is unreadable; retried on the next stash.
  }
}

/** Claim the newest matching draft. Deleting its file is the claim, so two windows never get the same one. */
function take(cwd: string, match: (draft: Draft) => boolean): Draft | undefined {
  for (const draft of list(cwd).reverse()) {
    if (!match(draft)) continue;
    try {
      unlinkSync(draft.file);
    } catch (error) {
      if (isMissing(error)) continue; // another window took it first
      throw error;
    }
    syncDir(stashDir(cwd));
    return { text: draft.text, session: draft.session };
  }
  return undefined;
}

/** First line of a draft, with control characters (ESC, BEL, …) removed, for the widget. */
export function preview(text: string, max = 60): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\p{Cc}/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export default function stash(pi: ExtensionAPI) {
  const updateWidget = (ctx: ExtensionContext) => {
    const drafts = list(ctx.cwd);
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

  /** Run a stash step and report a failure. Editor changes happen only after a step commits. */
  const run = (ctx: ExtensionContext, action: () => void) => {
    try {
      action();
    } catch (error) {
      ctx.ui.notify(`Stash failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

  /**
   * Put a claimed draft in the editor first, so a later widget failure can't lose it.
   * The widget refreshes either way: another window may have taken the draft it showed.
   */
  const restore = (ctx: ExtensionContext, draft: Draft | undefined) => {
    if (draft) ctx.ui.setEditorText(draft.text);
    run(ctx, () => updateWidget(ctx));
  };

  // Only the terminal UI has a real editor; RPC's getEditorText() is always ''.
  const tui = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === 'tui';

  pi.on('session_start', async (_event, ctx) => {
    if (tui(ctx)) run(ctx, () => updateWidget(ctx));
  });

  pi.registerShortcut('ctrl+s', {
    description: 'Stash / restore the typed message',
    handler: async (ctx) => {
      if (!tui(ctx)) return;
      const text = ctx.ui.getEditorText();
      if (text.trim().length === 0) {
        run(ctx, () =>
          restore(
            ctx,
            take(ctx.cwd, () => true),
          ),
        );
        return;
      }
      let saved = false;
      run(ctx, () => {
        add(ctx.cwd, { text, session: ctx.sessionManager.getSessionId() });
        saved = true;
      });
      if (!saved) return; // the draft stays in the editor
      ctx.ui.setEditorText('');
      trim(ctx.cwd);
      run(ctx, () => updateWidget(ctx));
    },
  });

  // Where the last prompt came from. Runs started by other extensions
  // (sendUserMessage, triggerTurn) must not pull a draft into the editor.
  let lastInputSource: string | undefined;
  pi.on('input', async (event) => {
    lastInputSource = event.source;
    return { action: 'continue' };
  });

  // After the user submits a message, auto-restore this session's most recent
  // stash into the now-empty editor (mirrors Claude Code's behavior). Drafts
  // stashed by other windows stay put until restored with ctrl+s.
  pi.on('before_agent_start', async (event, ctx) => {
    const typed = event.messageType === 'user' && lastInputSource === 'interactive';
    lastInputSource = undefined;
    if (!typed || !tui(ctx) || ctx.ui.getEditorText().trim().length > 0) return;
    const session = ctx.sessionManager.getSessionId();
    run(ctx, () =>
      restore(
        ctx,
        take(ctx.cwd, (draft) => draft.session === session),
      ),
    );
  });
}
