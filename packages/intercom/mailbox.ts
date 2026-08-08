/**
 * Letter transport for the intercom mailbox. Pi-free.
 *
 * Guarantees (each pinned by a test):
 * - A reader never sees half a letter: writers rename into place; readers
 *   only look at `*.json`.
 * - Nothing is delivered twice: a letter is unlinked as it is read, BEFORE
 *   the caller handles it.
 * - A corrupt letter is discarded on read, so it cannot poison every drain.
 * - Consumption is the receipt: the sender learns "delivered" only when the
 *   letter actually disappeared from the target's inbox.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { asksDir, inboxDir } from './registry.js';

export type LetterKind = 'message' | 'ask' | 'reply' | 'cancel';

export interface Letter {
  id: string;
  from: { addr: string; name: string; cwd: string };
  kind: LetterKind;
  body: string;
  replyTo?: string;
  ts: number;
}

export const MAX_BODY_CHARS = 32 * 1024;

function letterFileName(letter: Letter): string {
  return `${letter.ts}-${letter.id.slice(0, 6)}.json`;
}

/** Atomic deposit: write to a tmp sibling, then rename into place. */
export function deposit(root: string, toAddr: string, letter: Letter): void {
  const dir = inboxDir(root, toAddr);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = letterFileName(letter);
  const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(letter), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
}

/**
 * Take every letter in the inbox, oldest first. Each letter is unlinked as
 * it is read — before parsing — so a crash mid-drain loses at most the
 * in-flight letter and never double-delivers.
 */
export function drain(root: string, addr: string): Letter[] {
  const dir = inboxDir(root, addr);
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
  const out: Letter[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      continue; // another drainer took it
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.id === 'string' && typeof parsed.body === 'string') {
        out.push(parsed as Letter);
      }
    } catch {
      // corrupt letter — discarded, cannot fail future drains
    }
  }
  return out;
}

export function unreadCount(root: string, addr: string): number {
  try {
    return fs.readdirSync(inboxDir(root, addr)).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/**
 * Watch an inbox for new mail. fs.watch with a 3s poll fallback (watch can
 * miss events). The callback is expected to drain; it must tolerate empty.
 * Returns an unwatch function. Timer/watcher are unref'd so they never keep
 * a process alive.
 */
export function watchInbox(root: string, addr: string, onMail: () => void): () => void {
  const dir = inboxDir(root, addr);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => onMail());
    watcher.unref();
  } catch {
    // poll-only fallback
  }
  const poll = setInterval(onMail, 3000);
  poll.unref();
  return () => {
    watcher?.close();
    clearInterval(poll);
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Consumption receipt: after depositing to a LIVE target, wait briefly for
 * the letter to vanish. 'delivered' means the receiver's drainer took it —
 * stronger than any transport ack.
 */
export async function awaitReceipt(
  root: string,
  toAddr: string,
  letter: Letter,
  timeoutMs = 1500,
): Promise<'delivered' | 'queued'> {
  const file = path.join(inboxDir(root, toAddr), letterFileName(letter));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(file)) return 'delivered';
    await sleep(100);
  }
  return fs.existsSync(file) ? 'queued' : 'delivered';
}

// ── Ask tracking ─────────────────────────────────────────────────────────
// Received asks live at <addr>.asks/<askId>.json until we reply; our
// outgoing asks live at <addr>.asks/out-<askId>.json until a reply/cancel
// arrives or we time out.

export interface OutAsk {
  askId: string;
  toAddr: string;
  body: string;
  ts: number;
}

function asksPath(root: string, addr: string, askId: string): string {
  return path.join(asksDir(root, addr), `${askId}.json`);
}

function outAskPath(root: string, addr: string, askId: string): string {
  return path.join(asksDir(root, addr), `out-${askId}.json`);
}

function writeJson0600(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function trackIncomingAsk(root: string, addr: string, letter: Letter): void {
  writeJson0600(asksPath(root, addr, letter.id), letter);
}

export function trackOutgoingAsk(root: string, addr: string, out: OutAsk): void {
  writeJson0600(outAskPath(root, addr, out.askId), out);
}

export function readIncomingAsk(root: string, addr: string, askId: string): Letter | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(asksPath(root, addr, askId), 'utf8'));
    return parsed && typeof parsed.id === 'string' ? (parsed as Letter) : null;
  } catch {
    return null;
  }
}

export function readOutgoingAsk(root: string, addr: string, askId: string): OutAsk | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(outAskPath(root, addr, askId), 'utf8'));
    return parsed && typeof parsed.toAddr === 'string' ? (parsed as OutAsk) : null;
  } catch {
    return null;
  }
}

/** Remove both sides of an ask id (incoming and/or outgoing). Idempotent. */
export function clearAsk(root: string, addr: string, askId: string): void {
  for (const file of [asksPath(root, addr, askId), outAskPath(root, addr, askId)]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }
}

/** Asks we have received and not yet answered, oldest first. */
export function pendingAsks(root: string, addr: string): Letter[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(asksDir(root, addr))
      .filter((f) => f.endsWith('.json') && !f.startsWith('out-'))
      .sort();
  } catch {
    return [];
  }
  const out: Letter[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(asksDir(root, addr), name), 'utf8'));
      if (parsed && typeof parsed.id === 'string') out.push(parsed as Letter);
    } catch {
      // skip corrupt entry
    }
  }
  return out;
}
