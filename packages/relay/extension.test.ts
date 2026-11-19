import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import relay from './index.js';
import {
  ackClaimedLetter,
  appendAudit,
  claimInbox,
  deposit,
  pendingAsks,
  readClaimedLetter,
  recoverInboxClaims,
  trackIncomingAsk,
  unreadCount,
  type Letter,
} from './mailbox.js';
import { deriveAddr, writeRecord, type SessionRecord } from './registry.js';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => process.env.PI_RELAY_DIR!,
}));

type Result = { content: Array<{ text: string }>; details: Record<string, unknown> };
type Execute = (
  id: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  update: undefined,
  ctx: ExtensionContext,
) => Promise<Result>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
const fixtures: string[] = [];
const shutdowns: Array<() => void> = [];
const originalRoot = process.env.PI_RELAY_DIR;
afterEach(() => {
  for (const shutdown of shutdowns.splice(0)) shutdown();
  if (originalRoot === undefined) delete process.env.PI_RELAY_DIR;
  else process.env.PI_RELAY_DIR = originalRoot;
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-extension-')));
  fixtures.push(root);
  process.env.PI_RELAY_DIR = root;
  return root;
}
function peer(id = 'peer'): SessionRecord {
  const now = Date.now();
  return {
    addr: deriveAddr('/work', id),
    sessionId: id,
    name: `Peer ${id}`,
    cwd: '/work',
    pid: process.pid,
    startedAt: now,
    lastSeenAt: now,
    status: 'idle',
    offline: true,
  };
}
type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> | undefined };
function start() {
  const handlers = new Map<string, Handler>();
  let execute!: Execute;
  let parameters: unknown;
  let branch: unknown[] = [];
  const sends: SentMessage[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const commands = new Map<string, CommandHandler>();
  const ctx = {
    cwd: '/work',
    sessionManager: { getSessionId: () => 'self', getCwd: () => '/work', getBranch: () => branch },
  } as unknown as ExtensionContext;
  const api = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    getSessionName: () => 'Self',
    registerTool: (tool: { execute: Execute; parameters: unknown }) => {
      execute = tool.execute;
      parameters = tool.parameters;
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command.handler);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
      sends.push({ message, options });
      branch.push({ ...message, type: 'custom_message' });
    },
  } as unknown as ExtensionAPI;
  relay(api);
  const emit = (name: string) => handlers.get(name)?.({}, ctx);
  emit('session_start');
  shutdowns.push(() => {
    emit('session_shutdown');
  });
  return {
    run: (args: Record<string, unknown>, signal?: AbortSignal) => execute('fixture-call', args, signal, undefined, ctx),
    setBranch: (entries: unknown[]) => {
      branch = entries;
    },
    emit,
    sends,
    entries,
    command: (name: string, args: string) => commands.get(name)!(args, { hasUI: true }),
    parameters,
  };
}
function delivery(l: Letter) {
  return { type: 'custom_message', customType: 'relay:delivery', details: l };
}

it('keeps the tool schema free of keywords OpenAI strict mode rejects', () => {
  fixture();
  expect(JSON.stringify(start().parameters)).not.toContain('uniqueItems');
});

it('registered discovery, exact sessionId send, watch, and invalid-limit recovery work together', async () => {
  const root = fixture();
  const p = peer();
  const host = start();
  writeRecord(root, p);
  const listing = await host.run({ action: 'list-cwd', sessionIds: [p.sessionId] });
  expect(listing.details.sessions).toMatchObject([{ sessionId: p.sessionId, address: p.addr, presence: 'offline' }]);
  const sent = await host.run({ action: 'send', to: p.sessionId, message: 'fixture summary' });
  expect(sent.details).toMatchObject({ target: p.addr, receipt: 'queued' });
  const claim = claimInbox(root, p.addr)!;
  expect(readClaimedLetter(root, p.addr, claim.claimToken, claim.fileTokens[0]!)?.id).toBe(sent.details.messageId);
  expect((await host.run({ action: 'watch', to: p.sessionId })).content[0]!.text).toContain('Watching');
  expect((await host.run({ action: 'list', limit: 0 })).details.outcome).toBe('error');
  expect((await host.run({ action: 'list', presence: 'all' })).details.outcome).toBe('success');
});

it('replies to ordinary messages after reload, excludes sibling branches, and preserves unrelated asks', async () => {
  const root = fixture();
  const p = peer();
  const host = start();
  writeRecord(root, p);
  const l: Letter = {
    id: 'ordinary-full-id',
    kind: 'message',
    body: 'hello',
    ts: Date.now(),
    from: { addr: p.addr, name: p.name, cwd: p.cwd },
  };
  const ask: Letter = { ...l, id: 'unrelated-ask', kind: 'ask' };
  trackIncomingAsk(root, deriveAddr('/work', 'self'), ask);
  host.setBranch([delivery(l)]);
  host.emit('session_shutdown');
  host.emit('session_start');
  writeRecord(root, p);
  const reply = await host.run({ action: 'reply', replyTo: l.id, message: 'answer' });
  expect(reply.details).toMatchObject({ replyTo: l.id, receipt: 'queued', target: p.addr });
  const claim = claimInbox(root, p.addr)!;
  expect(readClaimedLetter(root, p.addr, claim.claimToken, claim.fileTokens[0]!)).toMatchObject({
    kind: 'reply',
    replyTo: l.id,
  });
  expect(pendingAsks(root, deriveAddr('/work', 'self'))).toHaveLength(1);
  host.setBranch([]);
  expect((await host.run({ action: 'reply', replyTo: l.id, message: 'different answer' })).content[0]!.text).toContain(
    'active conversation',
  );
  expect(pendingAsks(root, deriveAddr('/work', 'self'))).toHaveLength(1);
});

it('preserves ask correlation and refuses ambiguous pending asks without depositing', async () => {
  const root = fixture();
  const p = peer();
  const host = start();
  writeRecord(root, p);
  const self = deriveAddr('/work', 'self');
  const ask: Letter = {
    id: 'ask-111',
    kind: 'ask',
    body: 'question',
    ts: Date.now(),
    from: { addr: p.addr, name: p.name, cwd: p.cwd },
  };
  trackIncomingAsk(root, self, ask);
  trackIncomingAsk(root, self, { ...ask, id: 'ask-222' });
  expect((await host.run({ action: 'reply', replyTo: 'ask-', message: 'answer' })).content[0]!.text).toContain(
    'ambiguous',
  );
  expect(pendingAsks(root, self)).toHaveLength(2);
  const reply = await host.run({ action: 'reply', replyTo: ask.id, message: 'answer' });
  expect(reply.details.replyTo).toBe(ask.id);
  expect(pendingAsks(root, self).map((l) => l.id)).toEqual(['ask-222']);
});

it('restores an offline queued letter and emits an exact durable receipt', async () => {
  const root = fixture();
  const p = peer();
  writeRecord(root, p);
  const self = deriveAddr('/work', 'self');
  const l: Letter = {
    id: 'queued-letter',
    kind: 'message',
    body: 'queued fixture',
    ts: Date.now(),
    from: { addr: p.addr, name: p.name, cwd: p.cwd },
  };
  deposit(root, self, l);
  start();
  const { awaitReceipt } = await import('./mailbox.js');
  expect(await awaitReceipt(root, self, l, 1800)).toBe('delivered');
});

it('delivers wake:false mail without triggering a turn, waking mail with one, and an ask always wakes', async () => {
  const root = fixture();
  const p = peer();
  writeRecord(root, p);
  const self = deriveAddr('/work', 'self');
  const from = { addr: p.addr, name: p.name, cwd: p.cwd };
  const quiet: Letter = { id: 'quiet-letter', kind: 'message', body: 'fyi only', ts: Date.now(), wake: false, from };
  const loud: Letter = { id: 'loud-letter', kind: 'message', body: 'wake up', ts: Date.now() + 1, from };
  // The mailbox layer does not validate wake, so a quiet ask can land on
  // disk; delivery must wake it anyway or it would never be answered.
  const quietAsk: Letter = { id: 'quiet-ask', kind: 'ask', body: 'answer me', ts: Date.now() + 2, wake: false, from };
  deposit(root, self, quiet);
  deposit(root, self, loud);
  deposit(root, self, quietAsk);
  const host = start();
  const { awaitReceipt } = await import('./mailbox.js');
  // All three letters are acked, so all landed in the session's context.
  expect(await awaitReceipt(root, self, quiet, 3000)).toBe('delivered');
  expect(await awaitReceipt(root, self, loud, 3000)).toBe('delivered');
  expect(await awaitReceipt(root, self, quietAsk, 3000)).toBe('delivered');
  const byId = (id: string) => host.sends.find((s) => (s.message.details as { id?: string } | undefined)?.id === id)!;
  expect(byId(quiet.id).options).toEqual({ triggerTurn: false });
  expect(byId(loud.id).options).toEqual({ triggerTurn: true, deliverAs: 'steer' });
  expect(byId(quietAsk.id).options).toEqual({ triggerTurn: true, deliverAs: 'steer' });
  expect(pendingAsks(root, self).map((l) => l.id)).toEqual([quietAsk.id]);
});

it('settles a waiting ask on shutdown and clears tracking for the original sender', async () => {
  const root = fixture();
  const p = peer();
  const host = start();
  writeRecord(root, p);
  const waiting = host.run({ action: 'ask', to: p.sessionId, message: 'shutdown fixture', timeoutMs: 1000 });
  await Promise.resolve();
  host.emit('session_shutdown');
  expect((await waiting).content[0]!.text).toContain('session shutdown');
  expect(pendingAsks(root, deriveAddr('/work', 'self'))).toEqual([]);
});

it('does not register a late ask waiter when shutdown happens during the delivery receipt', async () => {
  const root = fixture();
  const p = peer();
  p.offline = false;
  const host = start();
  writeRecord(root, p);
  const started = Date.now();
  const waiting = host.run({ action: 'ask', to: p.sessionId, message: 'receipt shutdown fixture', timeoutMs: 120000 });
  await Promise.resolve();
  host.emit('session_shutdown');
  expect((await waiting).content[0]!.text).toContain('session shutdown');
  expect(Date.now() - started).toBeLessThan(4500);
});

it('discards a claimed letter with a malformed sender instead of requeueing it forever', async () => {
  const root = fixture();
  const self = deriveAddr('/work', 'self');
  const ts = Date.now();
  const inbox = path.join(root, `${self}.inbox`);
  fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  // No `from`: the unvalidated reader accepted this, then delivery threw and requeued it every ~5s.
  fs.writeFileSync(
    path.join(inbox, `${ts}-poison.json`),
    JSON.stringify({ id: 'poison', ts, kind: 'message', body: 'x' }),
  );
  const host = start();
  await new Promise((resolve) => setTimeout(resolve, 1800));
  expect(unreadCount(root, self)).toBe(0);
  expect(recoverInboxClaims(root, self).flatMap((claim) => claim.fileTokens)).toEqual([]);
  expect(host.sends.filter((s) => s.message.customType === 'relay:delivery')).toEqual([]);
});

it('discards a letter with an invalid replyTo without writing delivery proof', async () => {
  const root = fixture();
  const p = peer();
  writeRecord(root, p);
  const self = deriveAddr('/work', 'self');
  const from = { addr: p.addr, name: p.name, cwd: p.cwd };
  const ts = Date.now();
  // replyTo fails the validated reader (assertAskId) but passes the ACK writer's own shape check.
  const bad: Letter = { id: 'bad-reply', kind: 'reply', body: 'x', ts, replyTo: '../not-an-ask', from };
  const good: Letter = { id: 'good-letter', kind: 'message', body: 'ok', ts: ts + 1, from };
  deposit(root, self, bad);
  deposit(root, self, good);
  const host = start();
  const { awaitReceipt } = await import('./mailbox.js');
  expect(await awaitReceipt(root, self, good, 3000)).toBe('delivered');
  expect(unreadCount(root, self)).toBe(0);
  expect(recoverInboxClaims(root, self).flatMap((claim) => claim.fileTokens)).toEqual([]);
  expect(fs.existsSync(path.join(root, `${self}.acks`, `${bad.ts}-${bad.id}.json`))).toBe(false);
  expect(await awaitReceipt(root, self, bad, 0)).not.toBe('delivered');
  expect(host.sends.map((s) => (s.message.details as { id?: string } | undefined)?.id)).not.toContain(bad.id);
});

it('routes a reply that arrives before the ask receipt settles to the waiting ask', async () => {
  const root = fixture();
  const p = peer();
  p.offline = false;
  const host = start();
  writeRecord(root, p);
  const self = deriveAddr('/work', 'self');
  let answered = false;
  // A scripted peer that replies first and only acks the ask afterwards.
  const consumer = setInterval(() => {
    if (answered) return;
    const claim = claimInbox(root, p.addr);
    if (!claim) return;
    const ask = readClaimedLetter(root, p.addr, claim.claimToken, claim.fileTokens[0]!)!;
    answered = true;
    deposit(root, self, {
      id: 'early-reply',
      kind: 'reply',
      replyTo: ask.id,
      body: 'pong',
      ts: Date.now(),
      from: { addr: p.addr, name: p.name, cwd: p.cwd },
    });
    setTimeout(() => ackClaimedLetter(root, p.addr, claim.claimToken, claim.fileTokens[0]!), 800);
  }, 50);
  try {
    const started = Date.now();
    const result = await host.run({ action: 'ask', to: p.sessionId, message: 'ping', timeoutMs: 10_000 });
    expect(result.content[0]!.text).toContain('replied:\n\npong');
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    clearInterval(consumer);
  }
}, 15_000);

it('watch notifies idle↔working changes and survives an unreadable root', () => {
  const root = fixture();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const p = peer();
    p.offline = false;
    const host = start();
    writeRecord(root, p);
    void host.run({ action: 'watch', to: p.sessionId });
    writeRecord(root, { ...p, status: 'working', lastSeenAt: Date.now() });
    vi.advanceTimersByTime(5000);
    const notes = host.sends.filter((s) => s.message.customType === 'relay:notify');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message.content).toContain('is now working');
    expect(notes[0]!.options).toBeUndefined();

    // A root that becomes a symlink makes readRecord throw; the timer must not.
    const parked = `${root}-parked`;
    fixtures.push(parked);
    fs.renameSync(root, parked);
    fs.symlinkSync(parked, root, 'dir');
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    host.emit('session_shutdown');
  } finally {
    vi.useRealTimers();
  }
});

it('/relay log falls back to 50 entries for a non-numeric count', async () => {
  const root = fixture();
  const host = start();
  const addr = deriveAddr('/work', 'self');
  for (let i = 0; i < 60; i++) {
    appendAudit(root, {
      ts: Date.now(),
      event: 'deposit',
      kind: 'message',
      from: addr,
      to: addr,
      messageId: `m${i}`,
      preview: '',
    });
  }
  await host.command('relay', 'log abc');
  await host.command('relay', 'log 5');
  const counts = host.entries.map((e) => (e.data as { entries: unknown[] }).entries.length);
  expect(counts).toEqual([50, 5]);
});
