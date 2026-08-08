/**
 * Session registry for the relay mailbox: who is around, where, and
 * whether they're reachable. Pi-free — importable from tests without pi's
 * loader.
 *
 * Design (from pi-peer's ARCHITECTURE.md):
 * - An address belongs to a CONVERSATION, not a process: hash of cwd + pi
 *   session id, so a resumed session (`pi -c`) answers to the same address
 *   and two sessions on one directory never share an inbox.
 * - A record outlives the process that wrote it — that's what makes a
 *   session addressable while it's down (mail waits on disk).
 * - Presence is a pid PLUS a heartbeat: pid alone can't tell wedged from
 *   healthy (and pids get reused); heartbeat alone can't tell crash from
 *   pause.
 * - Listing has NO side effects: reading the directory never deletes.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SessionRecord {
  addr: string;
  sessionId: string;
  name: string;
  cwd: string;
  pid: number;
  startedAt: number;
  lastSeenAt: number;
  status: 'idle' | 'working';
  offline?: boolean;
}

export type Presence = 'live' | 'stalled' | 'offline';

export const HEARTBEAT_STALE_MS = 45_000;
/** A mailbox holding undelivered mail is kept this long after last contact. */
export const SWEEP_MAIL_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function deriveAddr(cwd: string, sessionId: string): string {
  return crypto.createHash('sha256').update(`${cwd}${sessionId}`).digest('hex').slice(0, 12);
}

export function ensureRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    // best-effort on filesystems that support modes
  }
}

export function recordPath(root: string, addr: string): string {
  return path.join(root, `${addr}.json`);
}

export function inboxDir(root: string, addr: string): string {
  return path.join(root, `${addr}.inbox`);
}

export function asksDir(root: string, addr: string): string {
  return path.join(root, `${addr}.asks`);
}

export function writeRecord(root: string, record: SessionRecord): void {
  ensureRoot(root);
  const file = recordPath(root, record.addr);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readRecord(root: string, addr: string): SessionRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath(root, addr), 'utf8'));
    if (parsed && typeof parsed.addr === 'string' && typeof parsed.pid === 'number') {
      return parsed as SessionRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read-only listing, oldest first. Never mutates anything. */
export function listRecords(root: string): SessionRecord[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = readRecord(root, entry.name.slice(0, -'.json'.length));
    if (record) out.push(record);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but isn't ours — still alive
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function presenceOf(record: SessionRecord, now: number = Date.now()): Presence {
  if (record.offline) return 'offline';
  if (!pidAlive(record.pid)) return 'offline';
  return now - record.lastSeenAt < HEARTBEAT_STALE_MS ? 'live' : 'stalled';
}

function dirHasJson(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

function rmrf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // sweep is best-effort
  }
}

/**
 * Reclaim dead sessions' files. Rules (mail outranks tidiness):
 * - a running session is never touched;
 * - a mailbox holding undelivered mail is kept for SWEEP_MAIL_KEEP_MS;
 * - an offline but resumable session keeps its record (its address — new
 *   mail must remain deliverable while it's down);
 * - only an empty mailbox of a session that can no longer be resumed is
 *   discarded promptly.
 *
 * `sessionExists(sessionId)` reports whether pi can still resume the
 * session (its session file is present). When omitted, every offline
 * session is treated as resumable (the conservative choice).
 */
export function sweep(root: string, now: number = Date.now(), sessionExists?: (sessionId: string) => boolean): void {
  for (const record of listRecords(root)) {
    if (presenceOf(record, now) !== 'offline') continue;
    const hasMail = dirHasJson(inboxDir(root, record.addr)) || dirHasJson(asksDir(root, record.addr));
    const expired = now - record.lastSeenAt >= SWEEP_MAIL_KEEP_MS;
    if (hasMail && !expired) continue;
    if (!expired && (sessionExists?.(record.sessionId) ?? true)) continue;
    rmrf(inboxDir(root, record.addr));
    rmrf(asksDir(root, record.addr));
    try {
      fs.unlinkSync(recordPath(root, record.addr));
    } catch {
      // already gone
    }
  }
}
