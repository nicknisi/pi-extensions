import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import relay from './index.js';
import { claimInbox, deposit, pendingAsks, readClaimedLetter, trackIncomingAsk, type Letter } from './mailbox.js';
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
function start() {
  const handlers = new Map<string, Handler>();
  let execute!: Execute;
  let branch: unknown[] = [];
  const ctx = {
    cwd: '/work',
    sessionManager: { getSessionId: () => 'self', getCwd: () => '/work', getBranch: () => branch },
  } as unknown as ExtensionContext;
  const api = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    getSessionName: () => 'Self',
    registerTool: (tool: { execute: Execute }) => {
      execute = tool.execute;
    },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    sendMessage: (message: Record<string, unknown>) => {
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
  };
}
function delivery(l: Letter) {
  return { type: 'custom_message', customType: 'relay:delivery', details: l };
}

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
