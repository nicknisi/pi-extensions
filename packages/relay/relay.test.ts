/**
 * Relay mechanism tests — tmp dirs, no pi imports. The suite is the
 * specification: each case pins a guarantee from the design.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BOUNDARY_PREAMBLE, formatDelivery, formatListing, refusalAmbiguous, refusalUnknown } from './format.js';
import {
  awaitReceipt,
  clearAsk,
  deposit,
  drain,
  pendingAsks,
  readOutgoingAsk,
  trackIncomingAsk,
  trackOutgoingAsk,
  unreadCount,
  watchInbox,
  type Letter,
} from './mailbox.js';
import { BACKLOG_CAP, OutboundPolicy, inboundAccepts } from './policy.js';
import { deriveAddr, listRecords, presenceOf, sweep, writeRecord, type SessionRecord } from './registry.js';

const dirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-relay-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

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
