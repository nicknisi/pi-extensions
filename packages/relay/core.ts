/** Pi-free relay registry, mailbox, and policy API for non-extension consumers. */
import {
  ackClaimedLetter as ackClaimedLetterInternal,
  awaitReceipt as awaitReceiptInternal,
  claimInbox as claimInboxInternal,
  clearAsk as clearAskInternal,
  deposit as depositInternal,
  drain as drainInternal,
  pendingAsks as pendingAsksInternal,
  readAudit as readAuditInternal,
  readClaimedLetter as readClaimedLetterInternal,
  readIncomingAsk as readIncomingAskInternal,
  readOutgoingAsk as readOutgoingAskInternal,
  recoverInboxClaims as recoverInboxClaimsInternal,
  requeueClaimedLetter as requeueClaimedLetterInternal,
  resolveAskByRef as resolveAskByRefInternal,
  trackIncomingAsk as trackIncomingAskInternal,
  trackOutgoingAsk as trackOutgoingAskInternal,
  unreadCount as unreadCountInternal,
  watchInbox as watchInboxInternal,
  type AuditRecord,
  type InboxClaim,
  type Letter,
  type OutAsk,
  type SendReceipt,
} from './mailbox.js';
import {
  claimAlias as claimAliasInternal,
  clearAlias as clearAliasInternal,
  deriveAddr,
  isValidAliasName as isValidAliasNameInternal,
  listAliases as listAliasesInternal,
  listRecords as listRecordsInternal,
  presenceOf as presenceOfInternal,
  readAlias as readAliasInternal,
  readRecord as readRecordInternal,
  removeRecord,
  sweep as sweepInternal,
  writeRecord,
  type AliasRecord,
  type Presence,
  type SessionRecord,
} from './registry.js';

export {
  MAX_BODY_CHARS,
  previewBody,
  type AuditRecord,
  type InboxClaim,
  type Letter,
  type LetterKind,
  type OutAsk,
  type SendReceipt,
} from './mailbox.js';
export {
  BACKLOG_CAP,
  DEDUPE_WINDOW_MS,
  OutboundPolicy,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  inboundAccepts,
  type OutboundVerdict,
} from './policy.js';
export {
  HEARTBEAT_STALE_MS,
  SWEEP_MAIL_KEEP_MS,
  deriveAddr,
  isValidAliasName,
  type AliasRecord,
  type Presence,
  type SessionRecord,
} from './registry.js';

const ADDRESS_PATTERN = /^[a-f0-9]{12}$/;
const ASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const INBOX_CLAIM_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const INBOX_FILE_TOKEN_PATTERN = /^(0|[1-9][0-9]*)-[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/;

function assertAddress(addr: string): void {
  if (!ADDRESS_PATTERN.test(addr)) throw new TypeError(`Invalid relay address: ${addr}`);
}

function assertAliasName(name: string): void {
  if (!isValidAliasNameInternal(name)) throw new TypeError(`Invalid relay alias: ${name}`);
}

function assertAskId(id: string): void {
  if (!ASK_ID_PATTERN.test(id)) throw new TypeError(`Invalid relay ask/message id: ${id}`);
}

function assertInboxClaimToken(token: string): void {
  if (!INBOX_CLAIM_TOKEN_PATTERN.test(token)) throw new TypeError(`Invalid relay inbox claim token: ${token}`);
}

function assertInboxFileToken(token: string): void {
  if (!INBOX_FILE_TOKEN_PATTERN.test(token)) throw new TypeError(`Invalid relay inbox file token: ${token}`);
}

function assertLetter(letter: Letter): void {
  if (typeof letter !== 'object' || letter === null) throw new TypeError('Invalid relay letter');
  assertAskId(letter.id);
  if (typeof letter.from !== 'object' || letter.from === null) throw new TypeError('Invalid relay letter sender');
  assertAddress(letter.from.addr);
  if (typeof letter.from.name !== 'string' || typeof letter.from.cwd !== 'string') {
    throw new TypeError('Invalid relay letter sender');
  }
  if (!['message', 'ask', 'reply', 'cancel'].includes(letter.kind) || typeof letter.body !== 'string') {
    throw new TypeError('Invalid relay letter payload');
  }
  if (letter.replyTo !== undefined) assertAskId(letter.replyTo);
  if (!Number.isSafeInteger(letter.ts) || letter.ts < 0) {
    throw new TypeError(`Invalid relay letter timestamp: ${letter.ts}`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Invalid relay ${label}: ${value}`);
}

function assertStatus(status: unknown): asserts status is SessionRecord['status'] {
  if (status !== 'idle' && status !== 'working') throw new TypeError(`Invalid relay session status: ${status}`);
}

function isSafeLetter(letter: Letter): boolean {
  try {
    assertLetter(letter);
    return true;
  } catch {
    return false;
  }
}

function isSafeRecord(record: SessionRecord): boolean {
  try {
    assertAddress(record.addr);
    return true;
  } catch {
    return false;
  }
}

function isSafeAlias(alias: AliasRecord): boolean {
  try {
    assertAliasName(alias.name);
    assertAddress(alias.addr);
    return true;
  } catch {
    return false;
  }
}

function isSafeOutAsk(out: OutAsk): boolean {
  try {
    assertAskId(out.askId);
    assertAddress(out.toAddr);
    return true;
  } catch {
    return false;
  }
}

function isSafeAuditRecord(record: AuditRecord): boolean {
  try {
    assertAddress(record.from);
    assertAddress(record.to);
    assertAskId(record.messageId);
    return true;
  } catch {
    return false;
  }
}

export function readRecord(root: string, addr: string): SessionRecord | null {
  assertAddress(addr);
  const record = readRecordInternal(root, addr);
  return record && isSafeRecord(record) ? record : null;
}

export function listRecords(root: string): SessionRecord[] {
  return listRecordsInternal(root).filter(isSafeRecord);
}

export function presenceOf(record: SessionRecord, now: number = Date.now()): Presence {
  assertAddress(record.addr);
  return presenceOfInternal(record, now);
}

/**
 * Register (or re-register) a non-Pi host as a relay session. The address is
 * derived from `cwd` + `sessionId`, so re-registering keeps it, along with the
 * existing `startedAt`. The host must call `heartbeat` well inside
 * `HEARTBEAT_STALE_MS`.
 */
export function register(
  root: string,
  input: { sessionId: string; name: string; cwd: string; pid?: number; status?: SessionRecord['status'] },
): SessionRecord {
  assertNonEmptyString(input.sessionId, 'session id');
  assertNonEmptyString(input.name, 'session name');
  assertNonEmptyString(input.cwd, 'session cwd');
  const pid = input.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`Invalid relay session pid: ${pid}`);
  const status = input.status ?? 'idle';
  assertStatus(status);
  const addr = deriveAddr(input.cwd, input.sessionId);
  const now = Date.now();
  const record: SessionRecord = {
    addr,
    sessionId: input.sessionId,
    name: input.name,
    cwd: input.cwd,
    pid,
    startedAt: readRecord(root, addr)?.startedAt ?? now,
    lastSeenAt: now,
    status,
  };
  writeRecord(root, record);
  return record;
}

/**
 * Refresh a registered session's `lastSeenAt` (clearing `offline`), applying an
 * optional status or name. Returns null, writing nothing, if no record exists.
 */
export function heartbeat(
  root: string,
  addr: string,
  patch: { status?: SessionRecord['status']; name?: string } = {},
): SessionRecord | null {
  assertAddress(addr);
  if (patch.status !== undefined) assertStatus(patch.status);
  if (patch.name !== undefined) assertNonEmptyString(patch.name, 'session name');
  const existing = readRecord(root, addr);
  if (existing === null) return null;
  const { offline: _offline, ...rest } = existing;
  const record: SessionRecord = {
    ...rest,
    name: patch.name ?? rest.name,
    status: patch.status ?? rest.status,
    lastSeenAt: Date.now(),
  };
  writeRecord(root, record);
  return record;
}

/** Delete a session's record. Aliases pointing at it are cleared by the next `sweep`. */
export function unregister(root: string, addr: string): void {
  assertAddress(addr);
  removeRecord(root, addr);
}

export function readAlias(root: string, name: string): AliasRecord | null {
  assertAliasName(name);
  const alias = readAliasInternal(root, name);
  return alias && isSafeAlias(alias) ? alias : null;
}

export function listAliases(root: string): AliasRecord[] {
  return listAliasesInternal(root).filter(isSafeAlias);
}

export function claimAlias(root: string, name: string, addr: string, sessionId: string): AliasRecord {
  assertAliasName(name);
  assertAddress(addr);
  return claimAliasInternal(root, name, addr, sessionId);
}

export function clearAlias(root: string, name: string): void {
  assertAliasName(name);
  clearAliasInternal(root, name);
}

export function sweep(root: string, now: number = Date.now(), sessionExists?: (sessionId: string) => boolean): void {
  if (!listRecordsInternal(root).every(isSafeRecord) || !listAliasesInternal(root).every(isSafeAlias)) {
    throw new TypeError('Relay root contains an invalid address or alias');
  }
  sweepInternal(root, now, sessionExists);
}

export function deposit(root: string, toAddr: string, letter: Letter): void {
  assertAddress(toAddr);
  assertLetter(letter);
  // wake is validated on the write side only. The read path (isSafeLetter)
  // tolerates a non-boolean wake, so a letter from a writer that never
  // validated the field is still delivered (as waking mail: delivery only
  // honours wake === false) instead of being discarded after drain already
  // unlinked it.
  if (letter.wake !== undefined && typeof letter.wake !== 'boolean') {
    throw new TypeError(`Invalid relay letter wake flag: ${letter.wake}`);
  }
  if (letter.kind === 'ask' && letter.wake === false) {
    throw new TypeError('A quiet ask (wake: false) is refused: the receiver takes no turn, so it could never answer');
  }
  depositInternal(root, toAddr, letter);
}

export function drain(root: string, addr: string): Letter[] {
  assertAddress(addr);
  return drainInternal(root, addr).filter(isSafeLetter);
}

export function unreadCount(root: string, addr: string): number {
  assertAddress(addr);
  return unreadCountInternal(root, addr);
}

export function claimInbox(root: string, addr: string): InboxClaim | null {
  assertAddress(addr);
  return claimInboxInternal(root, addr);
}

export function recoverInboxClaims(root: string, addr: string): InboxClaim[] {
  assertAddress(addr);
  return recoverInboxClaimsInternal(root, addr);
}

export function readClaimedLetter(root: string, addr: string, claimToken: string, fileToken: string): Letter | null {
  assertAddress(addr);
  assertInboxClaimToken(claimToken);
  assertInboxFileToken(fileToken);
  const letter = readClaimedLetterInternal(root, addr, claimToken, fileToken);
  return letter && isSafeLetter(letter) ? letter : null;
}

export function ackClaimedLetter(root: string, addr: string, claimToken: string, fileToken: string): boolean {
  assertAddress(addr);
  assertInboxClaimToken(claimToken);
  assertInboxFileToken(fileToken);
  return ackClaimedLetterInternal(root, addr, claimToken, fileToken);
}

export function requeueClaimedLetter(root: string, addr: string, claimToken: string, fileToken: string): boolean {
  assertAddress(addr);
  assertInboxClaimToken(claimToken);
  assertInboxFileToken(fileToken);
  return requeueClaimedLetterInternal(root, addr, claimToken, fileToken);
}

export function watchInbox(root: string, addr: string, onMail: () => void): () => void {
  assertAddress(addr);
  return watchInboxInternal(root, addr, onMail);
}

export async function awaitReceipt(
  root: string,
  toAddr: string,
  letter: Letter,
  timeoutMs = 1500,
): Promise<SendReceipt> {
  assertAddress(toAddr);
  assertLetter(letter);
  return awaitReceiptInternal(root, toAddr, letter, timeoutMs);
}

export function trackIncomingAsk(root: string, addr: string, letter: Letter): void {
  assertAddress(addr);
  assertLetter(letter);
  trackIncomingAskInternal(root, addr, letter);
}

export function trackOutgoingAsk(root: string, addr: string, out: OutAsk): void {
  assertAddress(addr);
  assertAskId(out.askId);
  assertAddress(out.toAddr);
  trackOutgoingAskInternal(root, addr, out);
}

export function readIncomingAsk(root: string, addr: string, askId: string): Letter | null {
  assertAddress(addr);
  assertAskId(askId);
  const letter = readIncomingAskInternal(root, addr, askId);
  return letter && isSafeLetter(letter) ? letter : null;
}

export function readOutgoingAsk(root: string, addr: string, askId: string): OutAsk | null {
  assertAddress(addr);
  assertAskId(askId);
  const out = readOutgoingAskInternal(root, addr, askId);
  return out && isSafeOutAsk(out) ? out : null;
}

export function clearAsk(root: string, addr: string, askId: string): void {
  assertAddress(addr);
  assertAskId(askId);
  clearAskInternal(root, addr, askId);
}

export function resolveAskByRef(root: string, addr: string, replyTo: string): Letter | null {
  assertAddress(addr);
  assertAskId(replyTo);
  const letter = resolveAskByRefInternal(root, addr, replyTo);
  return letter && isSafeLetter(letter) ? letter : null;
}

export function pendingAsks(root: string, addr: string): Letter[] {
  assertAddress(addr);
  return pendingAsksInternal(root, addr).filter(isSafeLetter);
}

export function readAudit(root: string, limit = 50): AuditRecord[] {
  return readAuditInternal(root, limit).filter(isSafeAuditRecord);
}
