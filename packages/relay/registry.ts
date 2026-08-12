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
import * as path from 'node:path';
import {
  assertPathSegment,
  openRelayRoot,
  rethrowFilesystemError,
  RelayDirectoryHandle,
  RelayFilesystemError,
} from './filesystem.js';

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
  const directory = openRelayRoot(root, true)!;
  directory.close();
}

export function recordPath(root: string, addr: string): string {
  assertPathSegment(addr, 'relay address');
  return path.join(root, `${addr}.json`);
}

export function inboxDir(root: string, addr: string): string {
  assertPathSegment(addr, 'relay address');
  return path.join(root, `${addr}.inbox`);
}

export function asksDir(root: string, addr: string): string {
  assertPathSegment(addr, 'relay address');
  return path.join(root, `${addr}.asks`);
}

// ── Claimable aliases ────────────────────────────────────────────────────
// Durable, human-readable names (@ci, @dotfiles) that point at a session
// address. Last-claim-wins: `claimAlias` overwrites unconditionally. The
// alias outlives the process and survives restart (persisted on disk, not
// runtime-only); it is swept when the owning session's record is reaped.

export interface AliasRecord {
  name: string; // stored without the leading @
  addr: string;
  sessionId: string;
  claimedAt: number;
}

export function aliasesDir(root: string): string {
  return path.join(root, 'aliases');
}

export function aliasPath(root: string, name: string): string {
  assertPathSegment(name, 'relay alias');
  return path.join(aliasesDir(root), `${name}.json`);
}

export function writeAlias(root: string, alias: AliasRecord): void {
  if (!isValidAliasName(alias.name)) throw new TypeError(`Invalid relay alias: ${alias.name}`);
  const relay = openRelayRoot(root, true)!;
  try {
    const aliases = relay.openDirectory('aliases', true)!;
    try {
      aliases.writeFileAtomic(`${alias.name}.json`, JSON.stringify(alias, null, 2));
    } finally {
      aliases.close();
    }
  } finally {
    relay.close();
  }
}

/** Alias names: lowercase alnum start, then alnum/_/-, 1-32 chars. */
export function isValidAliasName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}

function readAliasFromDirectory(directory: RelayDirectoryHandle, name: string): AliasRecord | null {
  const raw = directory.readFile(`${name}.json`);
  if (raw === null) return null;
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed.name === 'string' && typeof parsed.addr === 'string') return parsed as AliasRecord;
  return null;
}

export function readAlias(root: string, name: string): AliasRecord | null {
  // The name can come from LLM-controlled tool input — never let it reach
  // the filesystem unvalidated (e.g. '@../../../../tmp/x').
  if (!isValidAliasName(name)) return null;
  const relay = openRelayRoot(root);
  if (relay === null) return null;
  try {
    const aliases = relay.openDirectory('aliases');
    if (aliases === null) return null;
    try {
      return readAliasFromDirectory(aliases, name);
    } catch (error) {
      rethrowFilesystemError(error);
      return null;
    } finally {
      aliases.close();
    }
  } finally {
    relay.close();
  }
}

export function listAliases(root: string): AliasRecord[] {
  const relay = openRelayRoot(root);
  if (relay === null) return [];
  try {
    const aliases = relay.openDirectory('aliases');
    if (aliases === null) return [];
    try {
      const out: AliasRecord[] = [];
      for (const entry of aliases.readDirectory()) {
        if (!entry.name.endsWith('.json')) continue;
        if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay alias: ${entry.name}`);
        if (!entry.isFile()) continue;
        try {
          const alias = readAliasFromDirectory(aliases, entry.name.slice(0, -'.json'.length));
          if (alias) out.push(alias);
        } catch (error) {
          rethrowFilesystemError(error);
        }
      }
      return out.sort((a, b) => a.claimedAt - b.claimedAt);
    } finally {
      aliases.close();
    }
  } catch (error) {
    rethrowFilesystemError(error);
    return [];
  } finally {
    relay.close();
  }
}

/** Last-claim-wins: overwrites any prior owner. */
export function claimAlias(root: string, name: string, addr: string, sessionId: string): AliasRecord {
  const alias: AliasRecord = { name, addr, sessionId, claimedAt: Date.now() };
  writeAlias(root, alias);
  return alias;
}

export function clearAlias(root: string, name: string): void {
  if (!isValidAliasName(name)) return;
  const relay = openRelayRoot(root);
  if (relay === null) return;
  try {
    const aliases = relay.openDirectory('aliases');
    if (aliases === null) return;
    try {
      aliases.unlinkFile(`${name}.json`);
    } catch (error) {
      rethrowFilesystemError(error);
      // deletion remains best-effort for ordinary I/O failures
    } finally {
      aliases.close();
    }
  } finally {
    relay.close();
  }
}

export function writeRecord(root: string, record: SessionRecord): void {
  const relay = openRelayRoot(root, true)!;
  try {
    relay.writeFileAtomic(`${record.addr}.json`, JSON.stringify(record, null, 2));
  } finally {
    relay.close();
  }
}

function readRecordFromDirectory(directory: RelayDirectoryHandle, addr: string): SessionRecord | null {
  const raw = directory.readFile(`${addr}.json`);
  if (raw === null) return null;
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed.addr === 'string' && typeof parsed.pid === 'number') return parsed as SessionRecord;
  return null;
}

export function readRecord(root: string, addr: string): SessionRecord | null {
  assertPathSegment(addr, 'relay address');
  const relay = openRelayRoot(root);
  if (relay === null) return null;
  try {
    return readRecordFromDirectory(relay, addr);
  } catch (error) {
    rethrowFilesystemError(error);
    return null;
  } finally {
    relay.close();
  }
}

/** Read-only listing, oldest first. Never mutates anything. */
export function listRecords(root: string): SessionRecord[] {
  const relay = openRelayRoot(root);
  if (relay === null) return [];
  try {
    const out: SessionRecord[] = [];
    for (const entry of relay.readDirectory()) {
      if (!entry.name.endsWith('.json')) continue;
      if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay record: ${entry.name}`);
      if (!entry.isFile()) continue;
      try {
        const record = readRecordFromDirectory(relay, entry.name.slice(0, -'.json'.length));
        if (record) out.push(record);
      } catch (error) {
        rethrowFilesystemError(error);
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  } catch (error) {
    rethrowFilesystemError(error);
    return [];
  } finally {
    relay.close();
  }
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

function dirHasJson(root: string, name: string): boolean {
  const relay = openRelayRoot(root);
  if (relay === null) return false;
  try {
    const directory = relay.openDirectory(name);
    if (directory === null) return false;
    try {
      return directory.readDirectory().some((entry) => {
        if (!entry.name.endsWith('.json')) return false;
        if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay entry: ${entry.name}`);
        return entry.isFile();
      });
    } finally {
      directory.close();
    }
  } catch (error) {
    rethrowFilesystemError(error);
    return false;
  } finally {
    relay.close();
  }
}

function claimsHaveJson(root: string, addr: string): boolean {
  const relay = openRelayRoot(root);
  if (relay === null) return false;
  try {
    const claims = relay.openDirectory(`${addr}.claims`);
    if (claims === null) return false;
    try {
      for (const entry of claims.readDirectory()) {
        if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay claim: ${entry.name}`);
        if (!entry.isDirectory()) continue;
        const claim = claims.openDirectory(entry.name);
        if (claim === null) continue;
        try {
          if (
            claim.readDirectory().some((file) => {
              if (!file.name.endsWith('.json')) return false;
              if (file.isSymbolicLink()) {
                throw new RelayFilesystemError(`Refusing symlinked claimed letter: ${file.name}`);
              }
              return file.isFile();
            })
          ) {
            return true;
          }
        } finally {
          claim.close();
        }
      }
      return false;
    } finally {
      claims.close();
    }
  } finally {
    relay.close();
  }
}

function removeClaims(directory: RelayDirectoryHandle, addr: string): void {
  const claimsName = `${addr}.claims`;
  const claims = directory.openDirectory(claimsName);
  if (claims === null) return;
  try {
    for (const entry of claims.readDirectory()) {
      if (entry.isSymbolicLink()) throw new RelayFilesystemError(`Refusing symlinked relay claim: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      claims.removeDirectory(entry.name);
    }
  } finally {
    claims.close();
  }
  directory.removeDirectory(claimsName);
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
    const hasMail =
      dirHasJson(root, `${record.addr}.inbox`) ||
      dirHasJson(root, `${record.addr}.asks`) ||
      claimsHaveJson(root, record.addr);
    const expired = now - record.lastSeenAt >= SWEEP_MAIL_KEEP_MS;
    if (hasMail && !expired) continue;
    if (!expired && (sessionExists?.(record.sessionId) ?? true)) continue;
    const relay = openRelayRoot(root);
    if (relay !== null) {
      try {
        relay.removeDirectory(`${record.addr}.inbox`);
        relay.removeDirectory(`${record.addr}.asks`);
        removeClaims(relay, record.addr);
        try {
          relay.unlinkFile(`${record.addr}.json`);
        } catch (error) {
          rethrowFilesystemError(error);
          // deletion remains best-effort for ordinary I/O failures
        }
      } finally {
        relay.close();
      }
    }
  }
  // Aliases are swept when the owning session dies: an alias whose record
  // was just reaped (or never existed) is reclaimed. A resumable-but-offline
  // session keeps its record, so it keeps its alias too.
  for (const alias of listAliases(root)) {
    if (readRecord(root, alias.addr) === null) clearAlias(root, alias.name);
  }
}
