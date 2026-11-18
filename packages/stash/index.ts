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
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

const WIDGET_KEY = 'message-stash';
/** Oldest drafts beyond this are dropped. */
export const MAX_DRAFTS = 10;
/** A lock is held for milliseconds; one older than this was left by a crashed process. */
const STALE_LOCK_MS = 10_000;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;

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

const BUSY = 'the stash is busy in another window; try again';

/**
 * Write drafts durably: fsync the temp file, rename it into place, then fsync
 * the directory. `owned` is checked right before the rename, so a window whose
 * lock was taken over never overwrites the new owner's write.
 */
function save(cwd: string, drafts: Draft[], owned: () => boolean): void {
  const file = stashFile(cwd);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(drafts));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!owned()) throw new Error(BUSY);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  // The update is committed once the rename succeeds; this only makes the rename itself
  // survive a power loss, so a failure here must not undo a restore. Windows can't open a directory.
  if (process.platform === 'win32') return;
  try {
    const dir = openSync(dirname(file), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    // best effort
  }
}

function lockAge(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return 0; // released meanwhile; just retry
  }
}

function lockOwner(lock: string): string | undefined {
  try {
    return readFileSync(join(lock, 'owner'), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` holding the directory's stash lock, so another Pi window can't read
 * and rewrite the same stash at the same time. `mkdir` is atomic, so whoever
 * creates the lock directory owns it; an owner token inside lets a holder tell
 * whether a window reclaiming a stale lock took its lock over.
 */
function withLock<T>(cwd: string, fn: (owned: () => boolean) => T): T {
  const lock = `${stashFile(cwd)}.lock`;
  const token = randomUUID();
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt >= LOCK_ATTEMPTS) throw new Error(BUSY);
      // Two windows can reclaim the same stale lock at once; the owner check in `save` stops the loser from writing.
      if (lockAge(lock) > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
      else Atomics.wait(pause, 0, 0, LOCK_RETRY_MS);
      continue;
    }
    try {
      writeFileSync(join(lock, 'owner'), token);
    } catch (error) {
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
    break;
  }
  const owned = () => lockOwner(lock) === token;
  try {
    return fn(owned);
  } finally {
    if (owned()) rmSync(lock, { recursive: true, force: true });
  }
}

/** Under the lock: re-read, change, and save only if `change` returned a new list. */
function update(cwd: string, change: (drafts: Draft[]) => Draft[]): Draft[] {
  return withLock(cwd, (owned) => {
    const current = load(cwd);
    const drafts = change(current);
    if (drafts !== current) save(cwd, drafts, owned);
    return drafts;
  });
}

/** Under the lock: remove and return the newest draft that matches. */
function take(cwd: string, match: (draft: Draft) => boolean): { draft?: Draft; drafts: Draft[] } {
  let draft: Draft | undefined;
  const drafts = update(cwd, (current) => {
    for (let i = current.length - 1; i >= 0; i--) {
      if (match(current[i]!)) {
        draft = current[i];
        return [...current.slice(0, i), ...current.slice(i + 1)];
      }
    }
    return current;
  });
  return draft ? { draft, drafts } : { drafts };
}

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
        if (load(ctx.cwd).length === 0) return; // cheap check without the lock
        const { draft, drafts } = take(ctx.cwd, () => true);
        if (draft) ctx.ui.setEditorText(draft.text);
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
      const own = (draft: Draft) => draft.session === session;
      // Every send lands here, so check without the lock first.
      if (!load(ctx.cwd).some(own)) return;
      const { draft, drafts } = take(ctx.cwd, own);
      if (!draft) return;
      ctx.ui.setEditorText(draft.text);
      updateWidget(ctx, drafts);
    });
  });
}
