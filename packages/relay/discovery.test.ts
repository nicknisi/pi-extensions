import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverRelaySessions, type RelayDiscoveryInput } from './discovery.js';
import { deriveAddr, writeRecord, type SessionRecord } from './registry.js';
import { resolveReplyTarget, resolveSessionTarget } from './routing.js';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-discovery-')));
  fixtures.push(root);
  return root;
}
function record(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    addr: deriveAddr('/work', id),
    sessionId: id,
    name: id,
    cwd: '/work',
    pid: process.pid,
    startedAt: 100,
    lastSeenAt: Date.now(),
    status: 'idle',
    ...over,
  };
}
function input(root: string, over: Partial<RelayDiscoveryInput> = {}): RelayDiscoveryInput {
  return { action: 'list-cwd', root, selfAddress: deriveAddr('/work', 'self'), activeCwd: '/work', ...over };
}

it('defaults to all peers sorted online-first, includes descendants, and supports exact lookups', () => {
  const root = fixture();
  const now = Date.now();
  for (const r of [
    record('self'),
    record('offline', { offline: true, lastSeenAt: now }),
    record('older', { lastSeenAt: now - 1000 }),
    record('live', { lastSeenAt: now }),
    record('child', { cwd: '/work/child', lastSeenAt: now - 2000 }),
    record('sibling', { cwd: '/workspace' }),
  ])
    writeRecord(root, r);
  const all = discoverRelaySessions(input(root, { now }));
  expect(all.details.sessions.map((r) => r.sessionId)).toEqual(['live', 'older', 'child', 'offline']);
  expect(
    discoverRelaySessions(input(root, { now, includeSubdirectories: false })).details.sessions.map((r) => r.sessionId),
  ).toEqual(['live', 'older', 'offline']);
  expect(
    discoverRelaySessions(input(root, { now, presence: 'online' })).details.sessions.map((r) => r.sessionId),
  ).toEqual(['live', 'older', 'child']);
  const exact = discoverRelaySessions(input(root, { now, sessionIds: ['offline', 'self', 'sibling', 'unknown'] }));
  expect(exact.details.sessions.map((r) => r.sessionId)).toEqual(['self', 'offline']);
  expect(exact.details.missingSessionIds).toEqual(['sibling', 'unknown']);
  expect(
    discoverRelaySessions(input(root, { action: 'list', now })).details.sessions.map((r) => r.sessionId),
  ).toContain('sibling');
});

it('pages with nextArguments and sanitizes peer-controlled display fields', () => {
  const root = fixture();
  for (let i = 0; i < 25; i++)
    writeRecord(root, record(`session-${String(i).padStart(2, '0')}`, { name: `\u001b[31mname-${i}\u0007` }));
  const first = discoverRelaySessions(input(root));
  expect(first.details).toMatchObject({ returned: 20, total: 25, hasMore: true });
  expect(first.text).not.toContain('\u001b');
  expect(first.text).toContain(first.details.sessions[0]!.address);
  const next = discoverRelaySessions(input(root, first.details.nextArguments));
  expect(next.details).toMatchObject({ offset: 20, returned: 5, hasMore: false });
  const seen = [...first.details.sessions, ...next.details.sessions].map((r) => r.sessionId);
  expect(new Set(seen).size).toBe(25);
  expect(() => discoverRelaySessions(input(root, { limit: 0 }))).toThrow(/limit/);
  expect(() => discoverRelaySessions(input(root, { offset: -1 }))).toThrow(/offset/);
  writeRecord(root, record('long', { name: 'x'.repeat(500) }));
  const long = discoverRelaySessions(input(root, { sessionIds: ['long'] })).details.sessions[0]!;
  expect(long.name.length).toBeLessThanOrEqual(96);
});

it('routes exact session IDs case-sensitively and refuses collisions instead of guessing', () => {
  const peer = record('Exact-ID', { name: 'Human title' });
  expect(resolveSessionTarget(peer.sessionId, [peer], 'self').record).toEqual(peer);
  expect(resolveSessionTarget('exact-id', [peer], 'self').error).toBeDefined();
  expect(
    resolveSessionTarget(peer.sessionId, [peer, record('other', { name: peer.sessionId })], 'self').error,
  ).toContain('ambiguous');
  expect(
    resolveSessionTarget(peer.sessionId, [peer, { ...peer, addr: deriveAddr('/other', peer.sessionId) }], 'self').error,
  ).toContain('ambiguous');
  expect(resolveSessionTarget(peer.sessionId, [peer], peer.addr).error).toBeDefined();
});

it('resolves ordinary replies from only the active branch and rejects conflicting senders and watcher entries', () => {
  const id = 'ordinary-message';
  const peer = record('peer');
  const entry = {
    type: 'custom_message',
    customType: 'relay:delivery',
    details: { id, kind: 'message', from: { addr: peer.addr } },
  };
  expect(resolveReplyTarget(id, [], [entry]).target).toEqual({ id, addr: peer.addr, ask: false });
  expect(resolveReplyTarget(id, [], []).error).toContain('active conversation');
  expect(resolveReplyTarget(id, [], [{ ...entry, details: { ...entry.details, kind: 'cancel' } }]).error).toBeDefined();
  expect(
    resolveReplyTarget(
      id,
      [],
      [entry, { ...entry, details: { ...entry.details, from: { addr: record('other').addr } } }],
    ).error,
  ).toContain('ambiguous');
  expect(resolveReplyTarget(id, [], [entry, entry]).target?.addr).toBe(peer.addr);
  expect(
    resolveReplyTarget(id, [], [entry, { ...entry, details: { ...entry.details, id: `${id}-longer` } }]).target?.id,
  ).toBe(id);
});
