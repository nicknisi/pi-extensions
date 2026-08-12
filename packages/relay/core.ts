/** Pi-free relay registry, mailbox, and policy API for non-extension consumers. */
import {
  awaitReceipt as awaitReceiptInternal,
  clearAsk as clearAskInternal,
  deposit as depositInternal,
  drain as drainInternal,
  pendingAsks as pendingAsksInternal,
  readAudit as readAuditInternal,
  readIncomingAsk as readIncomingAskInternal,
  readOutgoingAsk as readOutgoingAskInternal,
  resolveAskByRef as resolveAskByRefInternal,
  trackIncomingAsk as trackIncomingAskInternal,
  trackOutgoingAsk as trackOutgoingAskInternal,
  unreadCount as unreadCountInternal,
  watchInbox as watchInboxInternal,
  type AuditRecord,
  type Letter,
  type OutAsk,
} from './mailbox.js';
import {
  claimAlias as claimAliasInternal,
  clearAlias as clearAliasInternal,
  isValidAliasName as isValidAliasNameInternal,
  listAliases as listAliasesInternal,
  listRecords as listRecordsInternal,
  presenceOf as presenceOfInternal,
  readAlias as readAliasInternal,
  readRecord as readRecordInternal,
  sweep as sweepInternal,
  type AliasRecord,
  type Presence,
  type SessionRecord,
} from './registry.js';

export { MAX_BODY_CHARS, previewBody, type AuditRecord, type Letter, type LetterKind, type OutAsk } from './mailbox.js';
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

function assertAddress(addr: string): void {
  if (!ADDRESS_PATTERN.test(addr)) throw new TypeError(`Invalid relay address: ${addr}`);
}

function assertAliasName(name: string): void {
  if (!isValidAliasNameInternal(name)) throw new TypeError(`Invalid relay alias: ${name}`);
}

function assertAskId(id: string): void {
  if (!ASK_ID_PATTERN.test(id)) throw new TypeError(`Invalid relay ask/message id: ${id}`);
}

function assertLetter(letter: Letter): void {
  if (typeof letter !== 'object' || letter === null) throw new TypeError('Invalid relay letter');
  assertAskId(letter.id);
  if (typeof letter.from !== 'object' || letter.from === null) throw new TypeError('Invalid relay letter sender');
  assertAddress(letter.from.addr);
  if (letter.replyTo !== undefined) assertAskId(letter.replyTo);
  if (!Number.isFinite(letter.ts)) throw new TypeError(`Invalid relay letter timestamp: ${letter.ts}`);
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

export function watchInbox(root: string, addr: string, onMail: () => void): () => void {
  assertAddress(addr);
  return watchInboxInternal(root, addr, onMail);
}

export async function awaitReceipt(
  root: string,
  toAddr: string,
  letter: Letter,
  timeoutMs = 1500,
): Promise<'delivered' | 'queued'> {
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
