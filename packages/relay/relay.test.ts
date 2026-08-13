/**
 * Relay mechanism tests — tmp dirs, no pi imports. The suite is the
 * specification: each case pins a guarantee from the design.
 */

import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOUNDARY_PREAMBLE,
  formatAudit,
  formatDelivery,
  formatListing,
  refusalAmbiguous,
  refusalUnknown,
} from './format.js';
import {
  ackClaimedLetter,
  appendAudit,
  auditLogPath,
  awaitReceipt,
  claimInbox,
  clearAsk,
  deposit,
  drain,
  pendingAsks,
  previewBody,
  readAudit,
  readClaimedLetter,
  readIncomingAsk,
  readOutgoingAsk,
  recoverInboxClaims,
  requeueClaimedLetter,
  resolveAskByRef,
  trackIncomingAsk,
  trackOutgoingAsk,
  unreadCount,
  watchInbox,
  type Letter,
} from './mailbox.js';
import { BACKLOG_CAP, OutboundPolicy, inboundAccepts } from './policy.js';
import {
  claimAlias,
  clearAlias,
  deriveAddr,
  isValidAliasName,
  listAliases,
  listRecords,
  presenceOf,
  readAlias,
  readRecord,
  sweep,
  writeAlias,
  writeRecord,
  type AliasRecord,
  type SessionRecord,
} from './registry.js';

const require = createRequire(import.meta.url);
const dirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-relay-test-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

let swapSequence = 0;
function swapWhenPinned(target: string, replacement: string, operation: () => void): string {
  const parked = `${target}.pinned-${++swapSequence}`;
  const identity = fs.statSync(target);
  const mutableFs = require('node:fs') as { fstatSync: typeof fs.fstatSync };
  const originalFstatSync = mutableFs.fstatSync;
  let swapped = false;
  mutableFs.fstatSync = ((fd: number) => {
    const stat = originalFstatSync(fd);
    if (!swapped && stat.dev === identity.dev && stat.ino === identity.ino) {
      fs.renameSync(target, parked);
      fs.renameSync(replacement, target);
      swapped = true;
    }
    return stat;
  }) as typeof fs.fstatSync;
  syncBuiltinESMExports();
  try {
    operation();
  } finally {
    mutableFs.fstatSync = originalFstatSync;
    syncBuiltinESMExports();
  }
  expect(swapped).toBe(true);
  return parked;
}

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  const now = Date.now();
  return {
    addr: 'aaaa1111bbbb',
    sessionId: 'sid-1',
    name: 'alpha',
    cwd: '/tmp/alpha',
    pid: process.pid,
    startedAt: now - 60_000,
    lastSeenAt: now,
    status: 'idle',
    ...over,
  };
}

function letter(over: Partial<Letter> = {}): Letter {
  return {
    id: '019fd000-0000-0000-0000-000000000001',
    from: { addr: 'cccc2222dddd', name: 'beta', cwd: '/tmp/beta' },
    kind: 'message',
    body: 'hello',
    ts: Date.now(),
    ...over,
  };
}

describe('registry', () => {
  it('derives stable addresses per conversation, distinct per cwd and session', () => {
    const a = deriveAddr('/repo', 's1');
    expect(a).toBe(deriveAddr('/repo', 's1')); // stable across "resume"
    expect(a).toHaveLength(12);
    expect(a).not.toBe(deriveAddr('/repo', 's2'));
    expect(a).not.toBe(deriveAddr('/other', 's1'));
  });

  it('presence is pid plus heartbeat: live, stalled, offline', () => {
    expect(presenceOf(record())).toBe('live');
    expect(presenceOf(record({ lastSeenAt: Date.now() - 60_000 }))).toBe('stalled');
    expect(presenceOf(record({ offline: true }))).toBe('offline');
    expect(presenceOf(record({ pid: 2_000_000_000 }))).toBe('offline'); // dead pid
  });

  it('uses random exclusive temp files without overwriting a predictable temp', () => {
    const root = tmpRoot();
    const value = record();
    const outside = path.join(root, 'outside');
    const predictable = path.join(root, `${value.addr}.json.${process.pid}.tmp`);
    fs.writeFileSync(outside, 'outside-sentinel');
    fs.symlinkSync(outside, predictable, 'file');

    writeRecord(root, value);
    writeRecord(root, { ...value, name: 'updated' });

    expect(fs.readFileSync(outside, 'utf8')).toBe('outside-sentinel');
    expect(fs.lstatSync(predictable).isSymbolicLink()).toBe(true);
    expect(readRecord(root, value.addr)?.name).toBe('updated');
  });

  it('listing has no side effects and survives garbage files', () => {
    const root = tmpRoot();
    writeRecord(root, record());
    fs.writeFileSync(path.join(root, 'garbage.json'), 'not json');
    const before = fs.readdirSync(root).sort();
    const listed = listRecords(root);
    expect(listed).toHaveLength(1);
    expect(fs.readdirSync(root).sort()).toEqual(before); // nothing deleted
  });

  it('sweep: mail kept 30d, resumable kept, empty non-resumable reaped', () => {
    const root = tmpRoot();
    // offline with unread mail → kept (mail outranks tidiness)
    const withMail = record({ addr: 'mail00000001', offline: true, pid: 2_000_000_001 });
    writeRecord(root, withMail);
    deposit(root, withMail.addr, letter());
    // offline, empty, resumable → kept (address stays deliverable)
    const resumable = record({ addr: 'empty0000002', offline: true, pid: 2_000_000_002, sessionId: 'can-resume' });
    writeRecord(root, resumable);
    fs.mkdirSync(path.join(root, `${resumable.addr}.inbox`), { recursive: true });
    // offline, empty, NOT resumable → reaped promptly
    const gone = record({ addr: 'gone00000003', offline: true, pid: 2_000_000_003, sessionId: 'deleted' });
    writeRecord(root, gone);
    // offline with mail older than 30d → reaped
    const ancient = record({
      addr: 'old000000004',
      offline: true,
      pid: 2_000_000_004,
      sessionId: 'can-resume',
      lastSeenAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    writeRecord(root, ancient);
    deposit(root, ancient.addr, letter());

    sweep(root, Date.now(), (id) => id === 'can-resume');

    expect(
      listRecords(root)
        .map((r) => r.addr)
        .sort(),
    ).toEqual([resumable.addr, withMail.addr].sort());
    expect(unreadCount(root, withMail.addr)).toBe(1); // mail intact
  });

  it('sweep never touches a running session', () => {
    const root = tmpRoot();
    writeRecord(root, record()); // live: our pid, fresh heartbeat
    deposit(root, record().addr, letter());
    sweep(root);
    expect(listRecords(root)).toHaveLength(1);
    expect(unreadCount(root, record().addr)).toBe(1);
  });

  it('treats a recoverable durable claim as undelivered mail', () => {
    const root = tmpRoot();
    const crashed = record({ offline: true, pid: 2_000_000_005 });
    writeRecord(root, crashed);
    deposit(root, crashed.addr, letter());
    const claim = claimInbox(root, crashed.addr)!;

    sweep(root, Date.now(), () => false);

    expect(readRecord(root, crashed.addr)).not.toBeNull();
    expect(recoverInboxClaims(root, crashed.addr)).toEqual([claim]);
  });
});

describe('mailbox', () => {
  it('delivers oldest-first, exactly once, with no partial reads', () => {
    const root = tmpRoot();
    const addr = 'inbox0000001';
    deposit(root, addr, letter({ id: 'id-1', ts: 1000, body: 'first' }));
    deposit(root, addr, letter({ id: 'id-2', ts: 2000, body: 'second' }));
    // a half-written tmp file must be invisible
    fs.writeFileSync(path.join(root, `${addr}.inbox`, '3000-id-3.json.tmp'), '{"id"');

    const first = drain(root, addr);
    expect(first.map((l) => l.body)).toEqual(['first', 'second']);
    expect(drain(root, addr)).toEqual([]); // nothing twice
    expect(unreadCount(root, addr)).toBe(0);
  });

  it('discards corrupt letters without poisoning future drains', () => {
    const root = tmpRoot();
    const addr = 'inbox0000002';
    const dir = path.join(root, `${addr}.inbox`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1000-badbad.json'), '{nope');
    deposit(root, addr, letter({ id: 'id-9', ts: 2000, body: 'good' }));
    expect(drain(root, addr).map((l) => l.body)).toEqual(['good']);
  });

  it('receipt: delivered when the letter vanishes, queued when it stays', async () => {
    const root = tmpRoot();
    const addr = 'inbox0000003';
    const l1 = letter({ id: 'rcpt-1', ts: Date.now() });
    deposit(root, addr, l1);
    const drained = drain(root, addr); // receiver takes it
    expect(drained).toHaveLength(1);
    expect(await awaitReceipt(root, addr, l1, 400)).toBe('delivered');

    const l2 = letter({ id: 'rcpt-2', ts: Date.now() + 1 });
    deposit(root, addr, l2);
    expect(await awaitReceipt(root, addr, l2, 400)).toBe('queued');
  });

  it("a letter reads 'queued' to the sender until actually delivered (claim → fail → requeue → ack)", async () => {
    // The pi entry point's delivery flow: a claimed letter stays 'queued' to
    // the sender, a failed delivery returns it to the inbox for retry, and
    // the receipt flips to 'delivered' only after acceptance (ack). A crash
    // mid-claim leaves the letter recoverable instead of silently lost.
    const root = tmpRoot();
    const addr = 'inbox0000004';
    const l1 = letter({ id: 'rcpt-3', ts: Date.now() });
    deposit(root, addr, l1);

    const claim = claimInbox(root, addr)!;
    expect(claim.fileTokens).toHaveLength(1);
    // Claimed but not yet delivered: the sender must NOT see 'delivered'.
    expect(await awaitReceipt(root, addr, l1, 400)).toBe('queued');
    expect(readClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)?.id).toBe(l1.id);

    // Delivery failure: requeue returns the letter to the live inbox, and a
    // later claim picks it up again.
    expect(requeueClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)).toBe(true);
    expect(unreadCount(root, addr)).toBe(1);
    expect(recoverInboxClaims(root, addr)).toEqual([]);

    const retry = claimInbox(root, addr)!;
    expect(retry.fileTokens).toEqual(claim.fileTokens);

    // Crash after delivery but before ack: the letter is recoverable.
    expect(recoverInboxClaims(root, addr)).toEqual([retry]);

    // Acceptance: only the ack deletes the letter and flips the receipt.
    expect(ackClaimedLetter(root, addr, retry.claimToken, retry.fileTokens[0]!)).toBe(true);
    expect(recoverInboxClaims(root, addr)).toEqual([]);
    expect(await awaitReceipt(root, addr, l1, 400)).toBe('delivered');
  });

  it('watch fires on deposit (poll fallback covers missed events)', async () => {
    const root = tmpRoot();
    const addr = 'inbox0000004';
    let calls = 0;
    const unwatch = watchInbox(root, addr, () => {
      calls++;
    });
    try {
      deposit(root, addr, letter());
      const deadline = Date.now() + 4000;
      while (calls === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBeGreaterThan(0);
    } finally {
      unwatch();
    }
  });

  it('tracks asks in and out, and clears both sides', () => {
    const root = tmpRoot();
    const addr = 'asks00000001';
    trackIncomingAsk(root, addr, letter({ id: 'ask-in-1', kind: 'ask' }));
    trackOutgoingAsk(root, addr, { askId: 'ask-out-1', toAddr: 'peer1', body: 'q?', ts: Date.now() });

    expect(pendingAsks(root, addr).map((a) => a.id)).toEqual(['ask-in-1']); // out-* hidden
    expect(readOutgoingAsk(root, addr, 'ask-out-1')?.toAddr).toBe('peer1');

    clearAsk(root, addr, 'ask-in-1');
    clearAsk(root, addr, 'ask-out-1');
    expect(pendingAsks(root, addr)).toEqual([]);
    expect(readOutgoingAsk(root, addr, 'ask-out-1')).toBeNull();
  });

  it('offline-then-resume: mail deposited while away drains on return', () => {
    const root = tmpRoot();
    const addr = 'inbox0000005';
    // no record/watcher — session is "closed"; mail waits
    deposit(root, addr, letter({ body: 'while you were out' }));
    expect(unreadCount(root, addr)).toBe(1);
    // "resume": drain-on-start
    expect(drain(root, addr).map((l) => l.body)).toEqual(['while you were out']);
  });
});

describe('descriptor-relative filesystem safety', () => {
  it('keeps record reads on a pinned root after the configured root is swapped', () => {
    const root = tmpRoot();
    const replacement = `${root}.replacement`;
    fs.mkdirSync(replacement);
    writeRecord(root, record({ name: 'pinned' }));
    writeRecord(replacement, record({ name: 'attacker' }));

    const result: { current: SessionRecord | null } = { current: null };
    const parked = swapWhenPinned(root, replacement, () => {
      result.current = readRecord(root, record().addr);
    });

    expect(result.current?.name).toBe('pinned');
    expect(JSON.parse(fs.readFileSync(path.join(root, `${record().addr}.json`), 'utf8')).name).toBe('attacker');
    expect(JSON.parse(fs.readFileSync(path.join(parked, `${record().addr}.json`), 'utf8')).name).toBe('pinned');
  });

  it('deletes aliases through the pinned aliases descriptor after a child swap', () => {
    const root = tmpRoot();
    writeAlias(root, { name: 'ci', addr: 'aaaa1111bbbb', sessionId: 'pinned', claimedAt: 1 });
    const aliases = path.join(root, 'aliases');
    const replacement = path.join(root, 'aliases.replacement');
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, 'ci.json'), '{"sessionId":"attacker"}');

    const parked = swapWhenPinned(aliases, replacement, () => clearAlias(root, 'ci'));

    expect(fs.existsSync(path.join(parked, 'ci.json'))).toBe(false);
    expect(fs.readFileSync(path.join(aliases, 'ci.json'), 'utf8')).toContain('attacker');
  });

  it('appends audit records to the pinned root after a root swap', () => {
    const root = tmpRoot();
    const replacement = `${root}.replacement`;
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(root, 'audit.log'), '');
    fs.writeFileSync(path.join(replacement, 'audit.log'), 'attacker-sentinel\n');

    const parked = swapWhenPinned(root, replacement, () =>
      appendAudit(root, {
        ts: 1,
        event: 'deliver',
        kind: 'message',
        from: 'aaaa1111bbbb',
        to: 'cccc2222dddd',
        messageId: 'audit-race',
        preview: 'safe',
      }),
    );

    expect(fs.readFileSync(path.join(parked, 'audit.log'), 'utf8')).toContain('audit-race');
    expect(fs.readFileSync(path.join(root, 'audit.log'), 'utf8')).toBe('attacker-sentinel\n');
  });

  it('deposits and drains through pinned inbox descriptors after child swaps', () => {
    const depositRoot = tmpRoot();
    const addr = 'race00000001';
    const inbox = path.join(depositRoot, `${addr}.inbox`);
    const replacement = `${inbox}.replacement`;
    fs.mkdirSync(inbox);
    fs.mkdirSync(replacement);
    const deposited = letter({ id: 'deposit-race', ts: 1000 });

    const parkedInbox = swapWhenPinned(inbox, replacement, () => deposit(depositRoot, addr, deposited));
    expect(fs.readdirSync(inbox)).toEqual([]);
    expect(fs.readdirSync(parkedInbox).some((name) => name.endsWith('.json'))).toBe(true);

    const drainRoot = tmpRoot();
    const drainInbox = path.join(drainRoot, `${addr}.inbox`);
    const drainReplacement = `${drainInbox}.replacement`;
    fs.mkdirSync(drainInbox);
    fs.mkdirSync(drainReplacement);
    fs.writeFileSync(path.join(drainInbox, '1000-pinned.json'), JSON.stringify(letter({ id: 'drain-race' })));
    fs.writeFileSync(path.join(drainReplacement, '1000-attacker.json'), JSON.stringify(letter({ body: 'attacker' })));

    let drained: Letter[] = [];
    const parkedDrain = swapWhenPinned(drainInbox, drainReplacement, () => {
      drained = drain(drainRoot, addr);
    });
    expect(drained.map((entry) => entry.id)).toEqual(['drain-race']);
    expect(fs.readdirSync(parkedDrain)).toEqual([]);
    expect(fs.readdirSync(drainInbox)).toEqual(['1000-attacker.json']);
  });

  it('reads and clears asks through the pinned asks descriptor after child swaps', () => {
    const root = tmpRoot();
    const addr = 'race00000002';
    const ask = letter({ id: 'ask-race', kind: 'ask' });
    trackIncomingAsk(root, addr, ask);
    const asks = path.join(root, `${addr}.asks`);
    const replacement = `${asks}.replacement`;
    fs.mkdirSync(replacement);
    fs.writeFileSync(
      path.join(replacement, `${ask.id}.json`),
      JSON.stringify(letter({ id: ask.id, body: 'attacker' })),
    );

    const result: { current: Letter | null } = { current: null };
    const parked = swapWhenPinned(asks, replacement, () => {
      result.current = readIncomingAsk(root, addr, ask.id);
    });
    expect(result.current?.body).toBe('hello');

    const current = asks;
    const secondReplacement = `${asks}.second-replacement`;
    fs.mkdirSync(secondReplacement);
    fs.writeFileSync(
      path.join(secondReplacement, `${ask.id}.json`),
      JSON.stringify(letter({ body: 'second-attacker' })),
    );
    const parkedReplacement = swapWhenPinned(current, secondReplacement, () => clearAsk(root, addr, ask.id));
    expect(fs.existsSync(path.join(parkedReplacement, `${ask.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(parked, `${ask.id}.json`))).toBe(true);
    expect(fs.readFileSync(path.join(current, `${ask.id}.json`), 'utf8')).toContain('second-attacker');
  });

  it('keeps a watch on the pinned inbox and closes its descriptors', async () => {
    const root = tmpRoot();
    const descriptorDirectory = process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd';
    const descriptorCount = () => fs.readdirSync(descriptorDirectory).length;
    const addr = 'race00000003';
    const inbox = path.join(root, `${addr}.inbox`);
    const replacement = `${inbox}.replacement`;
    fs.mkdirSync(inbox);
    fs.mkdirSync(replacement);
    let calls = 0;
    let unwatch = () => {};
    const before = descriptorCount();

    const parked = swapWhenPinned(inbox, replacement, () => {
      unwatch = watchInbox(root, addr, () => calls++);
    });
    expect(descriptorCount()).toBeGreaterThanOrEqual(before + 2);
    try {
      fs.writeFileSync(path.join(parked, 'mail.json'), '{}');
      const deadline = Date.now() + 2000;
      while (calls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(calls).toBeGreaterThan(0);
    } finally {
      unwatch();
    }
    expect(descriptorCount()).toBe(before);
  });
});

describe('aliases', () => {
  function alias(over: Partial<AliasRecord> = {}): AliasRecord {
    return { name: 'ci', addr: 'aaaa1111bbbb', sessionId: 'sid-1', claimedAt: Date.now(), ...over };
  }

  it('claim is last-claim-wins and persists on disk across restart', () => {
    const root = tmpRoot();
    writeAlias(root, alias({ addr: 'old00000000', sessionId: 'old-sid' }));
    expect(readAlias(root, 'ci')?.addr).toBe('old00000000');
    // a new session claims the same name — overwrites
    claimAlias(root, 'ci', 'new00000001', 'new-sid');
    expect(readAlias(root, 'ci')?.addr).toBe('new00000001');
    expect(listAliases(root).map((a) => a.name)).toEqual(['ci']);
  });

  it('sweep reaps an alias whose owning session record is gone', () => {
    const root = tmpRoot();
    // live owner keeps its alias
    const live = record({ addr: 'live00000001', pid: process.pid });
    writeRecord(root, live);
    claimAlias(root, 'ci', live.addr, live.sessionId);
    sweep(root);
    expect(readAlias(root, 'ci')?.addr).toBe(live.addr);

    // owner record reaped (offline, empty, not resumable) → alias reaped too
    const dead = record({ addr: 'dead00000002', offline: true, pid: 2_000_000_010, sessionId: 'gone' });
    writeRecord(root, dead);
    claimAlias(root, 'dotfiles', dead.addr, dead.sessionId);
    sweep(root, Date.now(), () => false); // nothing resumable
    expect(readAlias(root, 'ci')?.addr).toBe(live.addr); // untouched
    expect(readAlias(root, 'dotfiles')).toBeNull();
  });

  it('a resumable-but-offline owner keeps its alias (deliverable while down)', () => {
    const root = tmpRoot();
    const down = record({ addr: 'down00000003', offline: true, pid: 2_000_000_011, sessionId: 'can-resume' });
    writeRecord(root, down);
    claimAlias(root, 'ci', down.addr, down.sessionId);
    sweep(root, Date.now(), (id) => id === 'can-resume');
    expect(readAlias(root, 'ci')?.addr).toBe(down.addr);
  });

  it('clearAlias is idempotent', () => {
    const root = tmpRoot();
    writeAlias(root, alias());
    clearAlias(root, 'ci');
    clearAlias(root, 'ci'); // no throw
    expect(readAlias(root, 'ci')).toBeNull();
    expect(readRecord(root, 'aaaa1111bbbb')).toBeNull(); // sanity: readRecord on missing → null
  });

  it('alias names are validated — traversal never reaches the filesystem', () => {
    const root = tmpRoot();
    expect(isValidAliasName('ci')).toBe(true);
    expect(isValidAliasName('dotfiles-2')).toBe(true);
    expect(isValidAliasName('../../tmp/x')).toBe(false);
    expect(isValidAliasName('..')).toBe(false);
    expect(isValidAliasName('a/b')).toBe(false);
    expect(isValidAliasName('UPPER')).toBe(false); // case-sensitive storage, lowercase-only names
    expect(isValidAliasName('')).toBe(false);
    // readAlias refuses invalid names outright (defense in depth behind resolveTarget)
    expect(readAlias(root, '../../../../etc/passwd')).toBeNull();
    expect(readAlias(root, 'UPPER')).toBeNull();
  });
});

describe('audit log', () => {
  it('append-only: deposit writes one line, never the full body', () => {
    const root = tmpRoot();
    const addr = 'aud00000001';
    const long = 'x'.repeat(500);
    deposit(root, addr, letter({ id: 'a-1', body: long, ts: 1000 }));
    const entries = readAudit(root, 100);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.event).toBe('deposit');
    expect(e.kind).toBe('message');
    expect(e.from).toBe(letter().from.addr);
    expect(e.to).toBe(addr);
    expect(e.messageId).toBe('a-1');
    // preview is bounded — the full 500-char body never lands in the log
    expect(e.preview).toBe(previewBody(long));
    expect(e.preview.length).toBeLessThan(long.length);
  });

  it('append-only survives corruption and returns a bounded tail', () => {
    const root = tmpRoot();
    for (let i = 0; i < 3; i++) deposit(root, 'aud00000002', letter({ id: `a-${i}`, ts: 1000 + i }));
    // a corrupt line must not poison reads (append-only, skip-on-parse-fail)
    fs.appendFileSync(path.join(root, 'audit.log'), '{not json}\n');
    const entries = readAudit(root, 2);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.messageId)).toEqual(['a-1', 'a-2']);
  });

  it('deliver and deposit both record (evidence survives drain-as-receipt)', () => {
    const root = tmpRoot();
    const addr = 'aud00000003';
    deposit(root, addr, letter({ id: 'd-1', kind: 'ask', body: 'can I push?' }));
    // drain consumes (unlinks) the letter, but the audit line stays
    drain(root, addr);
    const entries = readAudit(root);
    expect(entries.filter((e) => e.event === 'deposit' && e.messageId === 'd-1')).toHaveLength(1);
    // a deliver record is appended by index.ts deliver(); simulate it here:
    appendAudit(root, {
      ts: Date.now(),
      event: 'deliver',
      kind: 'ask',
      from: letter().from.addr,
      to: addr,
      messageId: 'd-1',
      preview: previewBody('can I push?'),
    });
    const after = readAudit(root).filter((e) => e.messageId === 'd-1');
    expect(after.map((e) => e.event)).toEqual(['deposit', 'deliver']);
  });

  it('audit log rotates at the 1 MB cap, keeping one previous generation', () => {
    const root = tmpRoot();
    const big = 'y'.repeat(1024);
    // ~1.1 MB of audit records
    for (let i = 0; i < 1100; i++) {
      appendAudit(root, {
        ts: 1000 + i,
        event: 'deposit',
        kind: 'message',
        from: 'from-addr',
        to: 'to-addr',
        messageId: `m-${i}`,
        preview: big,
      });
    }
    const file = auditLogPath(root);
    expect(fs.existsSync(`${file}.1`)).toBe(true); // rotated generation exists
    expect(fs.statSync(file).size).toBeLessThan(1024 * 1024); // fresh log is small
    expect(readAudit(root, 10).length).toBeGreaterThan(0); // still readable after rotation
  });

  it('previewBody strips ANSI/CSI escapes (peer-controlled text reaches raw terminals)', () => {
    expect(previewBody('hello \x1b[31mred\x1b[0m world')).toBe('hello red world');
    expect(previewBody('\x1b[2J\x1b[Hbye')).toBe('bye');
  });

  it('resolveAskByRef matches by id or unique prefix, never by inference', () => {
    const root = tmpRoot();
    const addr = 'ask00000001';
    const a1 = letter({ id: 'aaaa1111-0000-0000-0000-000000000001', kind: 'ask' });
    const a2 = letter({ id: 'bbbb2222-0000-0000-0000-000000000002', kind: 'ask' });
    trackIncomingAsk(root, addr, a1);
    trackIncomingAsk(root, addr, a2);
    expect(resolveAskByRef(root, addr, a1.id)?.id).toBe(a1.id); // exact id
    expect(resolveAskByRef(root, addr, 'bbbb2222')?.id).toBe(a2.id); // prefix
    expect(resolveAskByRef(root, addr, 'nope')).toBeNull(); // no match
    // one pending ask alone is NOT implicitly the reply target — caller must pass its ref
    expect(resolveAskByRef(root, addr, '')).toBeNull();
  });

  it('formatAudit renders entries and handles the empty case', () => {
    expect(formatAudit([])).toContain('No audit entries');
    const root = tmpRoot();
    deposit(root, 'aud00000004', letter({ id: 'f-1', kind: 'message', body: 'hello world' }));
    const text = formatAudit(readAudit(root));
    expect(text).toContain('deposit');
    expect(text).toContain('f-1'.slice(0, 8));
    expect(text).toContain('hello world'); // preview present
    // a long body is only present as its bounded preview
    const root2 = tmpRoot();
    const long = 'A'.repeat(500);
    deposit(root2, 'aud00000005', letter({ id: 'f-2', body: long }));
    const text2 = formatAudit(readAudit(root2));
    expect(text2).not.toContain(long);
  });
});

describe('inbound refuse', () => {
  it('refused mail is never consumed, so receipts honestly read queued', async () => {
    expect(inboundAccepts('refuse')).toBe(false);
    const root = tmpRoot();
    const l = letter({ id: 'refuse-0001', ts: Date.now() });
    deposit(root, 'refuse0000001', l);
    // index.ts checkInbox early-returns on refuse — drain never runs:
    if (inboundAccepts('refuse')) drain(root, 'refuse0000001');
    expect(unreadCount(root, 'refuse0000001')).toBe(1); // preserved, not silently dropped
    expect(await awaitReceipt(root, 'refuse0000001', l, 300)).toBe('queued');
  });
});

describe('policy', () => {
  it('caps message size with actionable guidance', () => {
    const p = new OutboundPolicy();
    const verdict = p.check('x'.repeat(33 * 1024), 0);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('cap');
  });

  it('dedupes identical text inside 10s', () => {
    let now = 1_000_000;
    const p = new OutboundPolicy(() => now);
    expect(p.check('same', 0).ok).toBe(true);
    p.recordSend('same');
    expect(p.check('same', 0).ok).toBe(false);
    now += 11_000;
    expect(p.check('same', 0).ok).toBe(true);
  });

  it('dedupe is per-target: a broadcast of one body reaches distinct peers', () => {
    const p = new OutboundPolicy();
    expect(p.check('main moved', 0, 'peerA').ok).toBe(true);
    p.recordSend('main moved', 'peerA');
    // same body, different peer → not deduped (loop-breaking is per-peer)
    expect(p.check('main moved', 0, 'peerB').ok).toBe(true);
    p.recordSend('main moved', 'peerB');
    // same body, same peer again → still deduped inside the window
    expect(p.check('main moved', 0, 'peerA').ok).toBe(false);
  });

  it('rate limits at 8 per 30s', () => {
    const p = new OutboundPolicy();
    for (let i = 0; i < 8; i++) {
      expect(p.check(`m${i}`, 0).ok).toBe(true);
      p.recordSend(`m${i}`);
    }
    expect(p.check('one more', 0).ok).toBe(false);
  });

  it('refuses when the peer backlog is full', () => {
    const p = new OutboundPolicy();
    expect(p.check('hi', BACKLOG_CAP).ok).toBe(false);
    expect(p.check('hi', BACKLOG_CAP - 1).ok).toBe(true);
  });
});

describe('format', () => {
  it('pins the delivery shape: boundary, origin, body, ask hint', () => {
    const text = formatDelivery(letter({ kind: 'ask', body: 'can I push?' }));
    expect(text).toContain(BOUNDARY_PREAMBLE);
    expect(text).toContain('From pi session "beta" (/tmp/beta)');
    expect(text).toContain('can I push?');
    expect(text).toContain('action: "reply"');
    expect(text).toContain('replyTo');
  });

  it('pins the listing shape and filters self', () => {
    const text = formatListing(
      [record({ addr: 'self00000000' }), record({ addr: 'peer00000001', name: 'beta' })],
      'self00000000',
      () => 'live',
    );
    expect(text).not.toContain('self00000000');
    expect(text).toContain('beta (peer00) — /tmp/alpha [idle]');
  });

  it('pins refusal strings', () => {
    expect(refusalUnknown('nobody', ['"alpha" (aaaa11)'])).toContain('No session matches');
    expect(refusalAmbiguous('al', ['"alpha" (aaaa11)', '"alpine" (bbbb22)'])).toContain('ambiguous');
  });
});
