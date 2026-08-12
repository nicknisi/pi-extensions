/**
 * Letter transport for the relay mailbox. Pi-free.
 *
 * Guarantees (each pinned by a test):
 * - A reader never sees half a letter: writers rename into place; readers
 *   only look at `*.json`.
 * - Nothing is delivered twice: a letter is unlinked as it is read, BEFORE
 *   the caller handles it.
 * - A corrupt letter is discarded on read, so it cannot poison every drain.
 * - Consumption is the receipt: the sender learns "delivered" only when the
 *   letter actually disappeared from the target's inbox.
 * - Every deposit and every delivery appends one append-only audit line —
 *   drain-as-receipt must not destroy evidence. The log never holds a full
 *   body, only a short preview.
 */

import * as path from 'node:path';
import {
  assertPathSegment,
  openRelayRoot,
  rethrowFilesystemError,
  RelayDirectoryHandle,
  RelayFilesystemError,
  type RelayWatcher,
} from './filesystem.js';

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
  const name = `${letter.ts}-${letter.id.slice(0, 6)}.json`;
  assertPathSegment(name, 'relay letter file name');
  return name;
}

/** Atomic deposit: write to a random exclusive tmp sibling, then rename into place. */
export function deposit(root: string, toAddr: string, letter: Letter): void {
  assertPathSegment(toAddr, 'relay address');
  const relay = openRelayRoot(root, true)!;
  try {
    // Refuse an unsafe audit target before committing the atomic letter; this
    // avoids reporting failure after a delivery has already landed.
    relay.verifyFile('audit.log');
    const inbox = relay.openDirectory(`${toAddr}.inbox`, true)!;
    try {
      inbox.writeFileAtomic(letterFileName(letter), JSON.stringify(letter));
    } finally {
      inbox.close();
    }
    // Send-side choke point: every send/ask/reply/cancel goes through here.
    appendAuditToDirectory(relay, {
      ts: Date.now(),
      event: 'deposit',
      kind: letter.kind,
      from: letter.from.addr,
      to: toAddr,
      messageId: letter.id,
      preview: previewBody(letter.body),
    });
  } finally {
    relay.close();
  }
}

/**
 * Take every letter in the inbox, oldest first. Each letter is unlinked as
 * it is read — before parsing — so it can never be delivered twice. The
 * tradeoff: a drained letter that is never delivered would be lost, so the
 * caller must re-deposit any letter it fails to deliver (checkInbox does).
 */
export function drain(root: string, addr: string): Letter[] {
  assertPathSegment(addr, 'relay address');
  const relay = openRelayRoot(root);
  if (relay === null) return [];
  try {
    const inbox = relay.openDirectory(`${addr}.inbox`);
    if (inbox === null) return [];
    try {
      const names = inbox
        .readDirectory()
        .filter((entry) => {
          if (!entry.name.endsWith('.json')) return false;
          if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay letter: ${entry.name}`);
          return entry.isFile();
        })
        .map((entry) => entry.name)
        .sort();
      const out: Letter[] = [];
      for (const name of names) {
        let raw: string | null;
        try {
          raw = inbox.readFile(name);
        } catch (error) {
          rethrowFilesystemError(error);
          continue;
        }
        if (raw === null) continue;
        try {
          if (!inbox.unlinkFile(name)) continue; // another drainer took it
        } catch (error) {
          rethrowFilesystemError(error);
          continue;
        }
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.id === 'string' && typeof parsed.body === 'string') out.push(parsed as Letter);
        } catch {
          // corrupt letter — discarded, cannot fail future drains
        }
      }
      return out;
    } finally {
      inbox.close();
    }
  } catch (error) {
    rethrowFilesystemError(error);
    return [];
  } finally {
    relay.close();
  }
}

export function unreadCount(root: string, addr: string): number {
  assertPathSegment(addr, 'relay address');
  const relay = openRelayRoot(root);
  if (relay === null) return 0;
  try {
    const inbox = relay.openDirectory(`${addr}.inbox`);
    if (inbox === null) return 0;
    try {
      return inbox.readDirectory().filter((entry) => {
        if (!entry.name.endsWith('.json')) return false;
        if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay letter: ${entry.name}`);
        return entry.isFile();
      }).length;
    } finally {
      inbox.close();
    }
  } catch (error) {
    rethrowFilesystemError(error);
    return 0;
  } finally {
    relay.close();
  }
}

/**
 * Watch an inbox for new mail. fs.watch with a 3s poll fallback (watch can
 * miss events). The callback is expected to drain; it must tolerate empty.
 * Returns an unwatch function. Timer/watcher are unref'd so they never keep
 * a process alive.
 */
export function watchInbox(root: string, addr: string, onMail: () => void): () => void {
  assertPathSegment(addr, 'relay address');
  let relay: RelayDirectoryHandle | null = null;
  let inbox: RelayDirectoryHandle | null = null;
  let watcher: RelayWatcher | undefined;
  try {
    relay = openRelayRoot(root, true)!;
    inbox = relay.openDirectory(`${addr}.inbox`, true)!;
    watcher = inbox.watch(onMail);
    watcher.unref();
  } catch (error) {
    inbox?.close();
    relay?.close();
    inbox = null;
    relay = null;
    rethrowFilesystemError(error);
    // poll-only fallback for ordinary watch failures
  }
  const poll = setInterval(onMail, 3000);
  poll.unref();
  return () => {
    watcher?.close();
    clearInterval(poll);
    inbox?.close();
    relay?.close();
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
  assertPathSegment(toAddr, 'relay address');
  const relay = openRelayRoot(root);
  if (relay === null) return 'delivered';
  try {
    const inbox = relay.openDirectory(`${toAddr}.inbox`);
    if (inbox === null) return 'delivered';
    try {
      const fileName = letterFileName(letter);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!inbox.fileExists(fileName)) return 'delivered';
        await sleep(100);
      }
      return inbox.fileExists(fileName) ? 'queued' : 'delivered';
    } finally {
      inbox.close();
    }
  } finally {
    relay.close();
  }
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

function askFileName(askId: string): string {
  assertPathSegment(askId, 'relay ask id');
  return `${askId}.json`;
}

function outAskFileName(askId: string): string {
  assertPathSegment(askId, 'relay ask id');
  return `out-${askId}.json`;
}

function writeAskJson(root: string, addr: string, fileName: string, value: unknown): void {
  assertPathSegment(addr, 'relay address');
  const relay = openRelayRoot(root, true)!;
  try {
    const asks = relay.openDirectory(`${addr}.asks`, true)!;
    try {
      asks.writeFileAtomic(fileName, JSON.stringify(value));
    } finally {
      asks.close();
    }
  } finally {
    relay.close();
  }
}

export function trackIncomingAsk(root: string, addr: string, letter: Letter): void {
  writeAskJson(root, addr, askFileName(letter.id), letter);
}

export function trackOutgoingAsk(root: string, addr: string, out: OutAsk): void {
  writeAskJson(root, addr, outAskFileName(out.askId), out);
}

function readAskFile(root: string, addr: string, fileName: string): unknown | null {
  assertPathSegment(addr, 'relay address');
  const relay = openRelayRoot(root);
  if (relay === null) return null;
  try {
    const asks = relay.openDirectory(`${addr}.asks`);
    if (asks === null) return null;
    try {
      const raw = asks.readFile(fileName);
      return raw === null ? null : JSON.parse(raw);
    } finally {
      asks.close();
    }
  } catch (error) {
    rethrowFilesystemError(error);
    return null;
  } finally {
    relay.close();
  }
}

export function readIncomingAsk(root: string, addr: string, askId: string): Letter | null {
  const parsed = readAskFile(root, addr, askFileName(askId));
  return parsed && typeof (parsed as Letter).id === 'string' ? (parsed as Letter) : null;
}

export function readOutgoingAsk(root: string, addr: string, askId: string): OutAsk | null {
  const parsed = readAskFile(root, addr, outAskFileName(askId));
  return parsed && typeof (parsed as OutAsk).toAddr === 'string' ? (parsed as OutAsk) : null;
}

/** Remove both sides of an ask id (incoming and/or outgoing). Idempotent. */
export function clearAsk(root: string, addr: string, askId: string): void {
  assertPathSegment(addr, 'relay address');
  const relay = openRelayRoot(root);
  if (relay === null) return;
  try {
    const asks = relay.openDirectory(`${addr}.asks`);
    if (asks === null) return;
    try {
      for (const fileName of [askFileName(askId), outAskFileName(askId)]) {
        try {
          asks.unlinkFile(fileName);
        } catch (error) {
          rethrowFilesystemError(error);
          // deletion remains best-effort for ordinary I/O failures
        }
      }
    } finally {
      asks.close();
    }
  } finally {
    relay.close();
  }
}

// ── Audit log ────────────────────────────────────────────────────────────
// Append-only line-delimited JSON at <root>/audit.log. Written from the
// deposit and deliver choke points so the record survives the letter being
// unlinked-as-read. Never holds a full body — only a short preview.

export interface AuditRecord {
  ts: number;
  event: 'deposit' | 'deliver' | 'deliver-failed';
  kind: Letter['kind'];
  from: string;
  to: string;
  messageId: string;
  preview: string;
}

const AUDIT_PREVIEW_CHARS = 80;

/** Whitespace-collapsed body preview — never the full payload. */
export function previewBody(body: string): string {
  // Strip ANSI/CSI escapes — the preview is peer-controlled text that can
  // reach a raw terminal via the non-UI /relay log print path.
  // eslint-disable-next-line no-control-regex
  return body
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AUDIT_PREVIEW_CHARS);
}

export function auditLogPath(root: string): string {
  return path.join(root, 'audit.log');
}

/** Audit log cap: at ~1 MB the current log becomes audit.log.1 (single generation) and a fresh log starts. */
const AUDIT_MAX_BYTES = 1024 * 1024;

function appendAuditToDirectory(directory: RelayDirectoryHandle, record: AuditRecord): void {
  try {
    const size = directory.appendFile('audit.log', `${JSON.stringify(record)}\n`);
    // Bounded growth: rotate once past the cap, keeping one previous generation.
    if (size > AUDIT_MAX_BYTES) directory.renameFile('audit.log', 'audit.log.1');
  } catch {
    // audit failure (including an unsafe path) never breaks the mail path
  }
}

/** Append one audit record. Best-effort: never throws (audit must not break delivery). */
export function appendAudit(root: string, record: AuditRecord): void {
  let relay: RelayDirectoryHandle | null = null;
  try {
    relay = openRelayRoot(root, true)!;
    appendAuditToDirectory(relay, record);
  } catch {
    // audit failure (including an unsafe path) never breaks the mail path
  } finally {
    relay?.close();
  }
}

/** Read the last `limit` audit entries (oldest-first within that tail). */
export function readAudit(root: string, limit = 50): AuditRecord[] {
  const relay = openRelayRoot(root);
  if (relay === null) return [];
  let raw: string | null;
  try {
    raw = relay.readFile('audit.log');
  } catch (error) {
    rethrowFilesystemError(error);
    return [];
  } finally {
    relay.close();
  }
  if (raw === null) return [];
  const out: AuditRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.ts === 'number' && typeof parsed.event === 'string') out.push(parsed as AuditRecord);
    } catch {
      // skip corrupt line — append-only, never fatal
    }
  }
  return out.slice(-limit);
}

/** Resolve a pending ask by explicit replyTo id or unique prefix. No inference. */
export function resolveAskByRef(root: string, addr: string, replyTo: string): Letter | null {
  if (!replyTo) return null; // empty prefix matches every id — an explicit ref is required
  return pendingAsks(root, addr).find((a) => a.id === replyTo || a.id.startsWith(replyTo)) ?? null;
}

/** Asks we have received and not yet answered, oldest first. */
export function pendingAsks(root: string, addr: string): Letter[] {
  assertPathSegment(addr, 'relay address');
  const relay = openRelayRoot(root);
  if (relay === null) return [];
  try {
    const asks = relay.openDirectory(`${addr}.asks`);
    if (asks === null) return [];
    try {
      const names = asks
        .readDirectory()
        .filter((entry) => {
          if (!entry.name.endsWith('.json') || entry.name.startsWith('out-')) return false;
          if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay ask: ${entry.name}`);
          return entry.isFile();
        })
        .map((entry) => entry.name)
        .sort();
      const out: Letter[] = [];
      for (const name of names) {
        try {
          const raw = asks.readFile(name);
          if (raw === null) continue;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.id === 'string') out.push(parsed as Letter);
        } catch (error) {
          rethrowFilesystemError(error);
          // skip corrupt entry
        }
      }
      return out;
    } finally {
      asks.close();
    }
  } catch (error) {
    rethrowFilesystemError(error);
    return [];
  } finally {
    relay.close();
  }
}

/** Outgoing ask ids, used by the Pi entry point for prefix resolution. */
export function outgoingAskIds(root: string, addr: string): string[] {
  assertPathSegment(addr, 'relay address');
  const relay = openRelayRoot(root);
  if (relay === null) return [];
  try {
    const asks = relay.openDirectory(`${addr}.asks`);
    if (asks === null) return [];
    try {
      return asks
        .readDirectory()
        .filter((entry) => {
          if (!entry.name.startsWith('out-') || !entry.name.endsWith('.json')) return false;
          if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay ask: ${entry.name}`);
          return entry.isFile();
        })
        .map((entry) => entry.name.slice('out-'.length, -'.json'.length));
    } finally {
      asks.close();
    }
  } catch (error) {
    rethrowFilesystemError(error);
    return [];
  } finally {
    relay.close();
  }
}
