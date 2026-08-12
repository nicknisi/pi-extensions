import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from './core.js';

interface RelayPackage {
  name: string;
  exports: Record<string, { types: string; default: string }>;
  peerDependenciesMeta: Record<string, { optional: boolean }>;
}

const relayDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(relayDir, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(relayDir, 'package.json'), 'utf8')) as RelayPackage;
const fixtures: string[] = [];

function fixture(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-relay-core-')));
  fixtures.push(dir);
  return dir;
}

function letter(over: Partial<core.Letter> = {}): core.Letter {
  return {
    id: '019fd000-0000-0000-0000-000000000001',
    from: { addr: core.deriveAddr('/sender', 'session'), name: 'sender', cwd: '/sender' },
    kind: 'ask',
    body: 'question',
    ts: Date.now(),
    ...over,
  };
}

afterEach(() => {
  while (fixtures.length > 0) fs.rmSync(fixtures.pop()!, { recursive: true, force: true });
});

describe('/core filesystem boundary', () => {
  it('rejects traversal in every address-bearing operation', async () => {
    const base = fixture();
    const root = path.join(base, 'relay');
    const badAddr = '../../../escaped';
    const validAddr = core.deriveAddr('/receiver', 'session');
    const validLetter = letter();
    const badRecord: core.SessionRecord = {
      addr: badAddr,
      sessionId: 'session',
      name: 'bad',
      cwd: '/tmp',
      pid: process.pid,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
      status: 'idle',
    };

    const calls = [
      () => core.readRecord(root, badAddr),
      () => core.presenceOf(badRecord),
      () => core.claimAlias(root, 'safe', badAddr, 'session'),
      () => core.deposit(root, badAddr, validLetter),
      () => core.deposit(root, validAddr, letter({ from: { ...validLetter.from, addr: badAddr } })),
      () => core.drain(root, badAddr),
      () => core.unreadCount(root, badAddr),
      () => core.claimInbox(root, badAddr),
      () => core.recoverInboxClaims(root, badAddr),
      () => core.readClaimedLetter(root, badAddr, '0'.repeat(32), `${validLetter.ts}-${validLetter.id}.json`),
      () => core.ackClaimedLetter(root, badAddr, '0'.repeat(32), `${validLetter.ts}-${validLetter.id}.json`),
      () => core.requeueClaimedLetter(root, badAddr, '0'.repeat(32), `${validLetter.ts}-${validLetter.id}.json`),
      () => core.watchInbox(root, badAddr, () => {}),
      () => core.trackIncomingAsk(root, badAddr, validLetter),
      () =>
        core.trackOutgoingAsk(root, badAddr, {
          askId: validLetter.id,
          toAddr: validAddr,
          body: 'question',
          ts: Date.now(),
        }),
      () =>
        core.trackOutgoingAsk(root, validAddr, {
          askId: validLetter.id,
          toAddr: badAddr,
          body: 'question',
          ts: Date.now(),
        }),
      () => core.readIncomingAsk(root, badAddr, validLetter.id),
      () => core.readOutgoingAsk(root, badAddr, validLetter.id),
      () => core.clearAsk(root, badAddr, validLetter.id),
      () => core.resolveAskByRef(root, badAddr, validLetter.id),
      () => core.pendingAsks(root, badAddr),
    ];

    for (const call of calls) expect(call).toThrow(TypeError);
    await expect(core.awaitReceipt(root, badAddr, validLetter, 1)).rejects.toThrow(TypeError);
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('creates an exact /var temp root through the protected system link', () => {
    const canonicalBase = fixture();
    expect(canonicalBase.startsWith('/private/var/')).toBe(true);
    const root = path.join('/var', path.relative('/private/var', canonicalBase), 'relay');
    const addr = core.deriveAddr('/receiver', 'session');
    const validLetter = letter();

    core.deposit(root, addr, validLetter);

    expect(fs.realpathSync.native(root)).toBe(path.join(canonicalBase, 'relay'));
    expect(core.drain(root, addr)).toEqual([validLetter]);
  });

  it('rejects symlinked roots and user-controlled symlinked ancestor components', () => {
    const base = fixture();
    const outside = path.join(base, 'outside');
    const root = path.join(base, 'relay');
    const addr = core.deriveAddr('/receiver', 'session');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, root, 'dir');

    expect(() => core.listRecords(root)).toThrow(/symlink/i);
    expect(() => core.deposit(root, addr, letter())).toThrow(/symlink/i);
    expect(fs.readdirSync(outside)).toEqual([]);

    fs.unlinkSync(root);
    const ancestor = path.join(base, 'ancestor');
    fs.symlinkSync(outside, ancestor, 'dir');
    const nestedRoot = path.join(ancestor, 'nested', 'relay');
    expect(() => core.listRecords(nestedRoot)).toThrow(/symlink/i);
    expect(() => core.deposit(nestedRoot, addr, letter())).toThrow(/symlink/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects symlinked inbox and ask directories in every access mode', async () => {
    const base = fixture();
    const root = path.join(base, 'relay');
    const outside = path.join(base, 'outside');
    const addr = core.deriveAddr('/receiver', 'session');
    const validLetter = letter();
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, `${addr}.inbox`), 'dir');

    for (const call of [
      () => core.deposit(root, addr, validLetter),
      () => core.drain(root, addr),
      () => core.unreadCount(root, addr),
      () => core.claimInbox(root, addr),
      () => core.watchInbox(root, addr, () => {}),
    ]) {
      expect(call).toThrow(/symlink/i);
    }
    await expect(core.awaitReceipt(root, addr, validLetter, 1)).rejects.toThrow(/symlink/i);

    fs.unlinkSync(path.join(root, `${addr}.inbox`));
    fs.symlinkSync(outside, path.join(root, `${addr}.asks`), 'dir');
    const out: core.OutAsk = {
      askId: validLetter.id,
      toAddr: core.deriveAddr('/peer', 'session'),
      body: 'question',
      ts: Date.now(),
    };
    for (const call of [
      () => core.trackIncomingAsk(root, addr, validLetter),
      () => core.trackOutgoingAsk(root, addr, out),
      () => core.readIncomingAsk(root, addr, validLetter.id),
      () => core.readOutgoingAsk(root, addr, validLetter.id),
      () => core.clearAsk(root, addr, validLetter.id),
      () => core.pendingAsks(root, addr),
      () => core.resolveAskByRef(root, addr, validLetter.id),
    ]) {
      expect(call).toThrow(/symlink/i);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects symlinked aliases, records, letters, asks, and audit files without following them', () => {
    const base = fixture();
    const root = path.join(base, 'relay');
    const outside = path.join(base, 'outside');
    const addr = core.deriveAddr('/receiver', 'session');
    const validLetter = letter();
    const sentinel = path.join(outside, 'sentinel.json');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(sentinel, '{"sentinel":true}');

    fs.symlinkSync(outside, path.join(root, 'aliases'), 'dir');
    for (const call of [
      () => core.claimAlias(root, 'ci', addr, 'session'),
      () => core.readAlias(root, 'ci'),
      () => core.listAliases(root),
      () => core.clearAlias(root, 'ci'),
    ]) {
      expect(call).toThrow(/symlink/i);
    }
    fs.unlinkSync(path.join(root, 'aliases'));

    fs.symlinkSync(sentinel, path.join(root, `${addr}.json`), 'file');
    expect(() => core.readRecord(root, addr)).toThrow(/symlink/i);
    expect(() => core.listRecords(root)).toThrow(/symlink/i);
    fs.unlinkSync(path.join(root, `${addr}.json`));

    const inbox = path.join(root, `${addr}.inbox`);
    fs.mkdirSync(inbox);
    fs.symlinkSync(sentinel, path.join(inbox, `${validLetter.ts}-${validLetter.id}.json`), 'file');
    expect(() => core.drain(root, addr)).toThrow(/symlink/i);
    fs.rmSync(inbox, { recursive: true, force: true });

    const asks = path.join(root, `${addr}.asks`);
    fs.mkdirSync(asks);
    fs.symlinkSync(sentinel, path.join(asks, `${validLetter.id}.json`), 'file');
    expect(() => core.readIncomingAsk(root, addr, validLetter.id)).toThrow(/symlink/i);
    expect(() => core.clearAsk(root, addr, validLetter.id)).toThrow(/symlink/i);
    fs.rmSync(asks, { recursive: true, force: true });

    fs.symlinkSync(sentinel, path.join(root, 'audit.log'), 'file');
    expect(() => core.readAudit(root)).toThrow(/symlink/i);
    expect(() => core.deposit(root, addr, validLetter)).toThrow(/symlink/i);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('{"sentinel":true}');
    expect(fs.existsSync(path.join(root, `${addr}.inbox`))).toBe(false);
  });

  it('durably claims same-millisecond letters without collisions and recovers by opaque tokens', async () => {
    const base = fixture();
    const root = path.join(base, 'relay');
    const addr = core.deriveAddr('/receiver', 'session');
    const ts = Date.now();
    const first = letter({ id: 'reply-prefix-000000000000000000000001', kind: 'reply', ts, body: 'first' });
    const second = letter({ id: 'reply-prefix-000000000000000000000002', kind: 'reply', ts, body: 'second' });

    core.deposit(root, addr, first);
    core.deposit(root, addr, second);
    expect(core.unreadCount(root, addr)).toBe(2);

    const claim = core.claimInbox(root, addr)!;
    expect(claim.claimToken).toMatch(/^[a-f0-9]{32}$/);
    expect(claim.claimToken).not.toContain('/');
    expect(claim.fileTokens).toEqual([`${ts}-${first.id}.json`, `${ts}-${second.id}.json`]);
    expect(claim.fileTokens.every((token) => !token.includes('/'))).toBe(true);
    expect(core.unreadCount(root, addr)).toBe(0);
    expect(await core.awaitReceipt(root, addr, first, 1)).toBe('queued');

    // A new process can recover the same stable claim/file tokens and read
    // letters without retaining a path or descriptor from claimInbox.
    expect(core.recoverInboxClaims(root, addr)).toEqual([claim]);
    expect(core.readClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)?.body).toBe('first');
    expect(core.readClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[1]!)?.body).toBe('second');

    const journal = fs.openSync(path.join(base, 'journal'), 'w');
    fs.writeFileSync(journal, JSON.stringify({ claim: claim.claimToken, file: claim.fileTokens[0] }));
    fs.fsyncSync(journal);
    fs.closeSync(journal);
    expect(core.ackClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)).toBe(true);
    expect(await core.awaitReceipt(root, addr, first, 1)).toBe('delivered');

    const later = letter({ id: 'later-message', ts: ts + 1, body: 'new inbox' });
    core.deposit(root, addr, later);
    expect(core.requeueClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[1]!)).toBe(true);
    expect(core.recoverInboxClaims(root, addr)).toEqual([]);
    expect(core.drain(root, addr).map((entry) => entry.body)).toEqual(['second', 'new inbox']);
  });

  it('never follows symlinked durable claims or claimed letters', () => {
    const base = fixture();
    const root = path.join(base, 'relay');
    const outside = path.join(base, 'outside');
    const addr = core.deriveAddr('/receiver', 'session');
    const claimToken = 'a'.repeat(32);
    const validLetter = letter();
    const fileToken = `${validLetter.ts}-${validLetter.id}.json`;
    const sentinel = path.join(outside, 'sentinel.json');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(sentinel, 'sentinel');

    fs.symlinkSync(outside, path.join(root, `${addr}.claims`), 'dir');
    core.deposit(root, addr, validLetter);
    for (const call of [
      () => core.claimInbox(root, addr),
      () => core.recoverInboxClaims(root, addr),
      () => core.readClaimedLetter(root, addr, claimToken, fileToken),
      () => core.ackClaimedLetter(root, addr, claimToken, fileToken),
      () => core.requeueClaimedLetter(root, addr, claimToken, fileToken),
    ]) {
      expect(call).toThrow(/symlink/i);
    }
    fs.unlinkSync(path.join(root, `${addr}.claims`));

    const claims = path.join(root, `${addr}.claims`);
    fs.mkdirSync(claims);
    fs.symlinkSync(outside, path.join(claims, claimToken), 'dir');
    for (const call of [
      () => core.recoverInboxClaims(root, addr),
      () => core.readClaimedLetter(root, addr, claimToken, fileToken),
      () => core.ackClaimedLetter(root, addr, claimToken, fileToken),
      () => core.requeueClaimedLetter(root, addr, claimToken, fileToken),
    ]) {
      expect(call).toThrow(/symlink/i);
    }
    fs.unlinkSync(path.join(claims, claimToken));

    const claim = path.join(claims, claimToken);
    fs.mkdirSync(claim);
    fs.symlinkSync(sentinel, path.join(claim, fileToken), 'file');
    for (const call of [
      () => core.recoverInboxClaims(root, addr),
      () => core.readClaimedLetter(root, addr, claimToken, fileToken),
      () => core.ackClaimedLetter(root, addr, claimToken, fileToken),
      () => core.requeueClaimedLetter(root, addr, claimToken, fileToken),
    ]) {
      expect(call).toThrow(/symlink/i);
    }
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('sentinel');
  });

  it('rejects traversal in aliases, claims, and ask/message identifiers', async () => {
    const base = fixture();
    const root = path.join(base, 'relay');
    const addr = core.deriveAddr('/receiver', 'session');
    const validLetter = letter();
    const badId = '../../../escaped';
    const badAlias = '../../../escaped';

    const calls = [
      () => core.readAlias(root, badAlias),
      () => core.claimAlias(root, badAlias, addr, 'session'),
      () => core.clearAlias(root, badAlias),
      () => core.deposit(root, addr, letter({ id: badId })),
      () => core.deposit(root, addr, letter({ replyTo: badId })),
      () => core.trackIncomingAsk(root, addr, letter({ id: badId })),
      () =>
        core.trackOutgoingAsk(root, addr, {
          askId: badId,
          toAddr: addr,
          body: 'question',
          ts: Date.now(),
        }),
      () => core.readIncomingAsk(root, addr, badId),
      () => core.readOutgoingAsk(root, addr, badId),
      () => core.clearAsk(root, addr, badId),
      () => core.resolveAskByRef(root, addr, badId),
      () => core.readClaimedLetter(root, addr, badId, `${validLetter.ts}-${validLetter.id}.json`),
      () => core.ackClaimedLetter(root, addr, '0'.repeat(32), badId),
      () => core.requeueClaimedLetter(root, addr, '0'.repeat(32), badId),
    ];

    for (const call of calls) expect(call).toThrow(TypeError);
    await expect(core.awaitReceipt(root, addr, letter({ id: badId }), 1)).rejects.toThrow(TypeError);
    expect(fs.readdirSync(base)).toEqual([]);

    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, `${addr}.json`), JSON.stringify({ addr: badId, pid: 2_000_000_000 }));
    expect(() => core.sweep(root, Date.now(), () => false)).toThrow(TypeError);
    expect(fs.readdirSync(base)).toEqual(['relay']);
  });
});

it('keeps the Pi extension entry importable', async () => {
  const entry = await import('./index.js');
  expect(typeof entry.default).toBe('function');
});

it('builds, packs, installs, and imports the real core package without Pi or TUI', () => {
  const base = fixture();
  const tarball = path.join(base, 'relay.tgz');
  const appDir = path.join(base, 'app');
  fs.mkdirSync(appDir);

  execFileSync('pnpm', ['--filter', packageJson.name, 'build'], { cwd: repoRoot, stdio: 'pipe' });
  execFileSync('pnpm', ['pack', '--out', tarball], { cwd: relayDir, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { [packageJson.name]: 'file:../relay.tgz' },
    }),
  );
  execFileSync('pnpm', ['install', '--offline', '--ignore-scripts'], { cwd: appDir, stdio: 'pipe' });

  const installedDir = path.join(appDir, 'node_modules', '@nicknisi', 'pi-relay');
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8')) as RelayPackage;
  const coreExport = installedPackage.exports['./core'];
  expect(coreExport).toBeDefined();
  for (const target of Object.values(coreExport!)) {
    expect(fs.existsSync(path.join(installedDir, target))).toBe(true);
  }
  expect(fs.existsSync(path.join(installedDir, 'filesystem.ts'))).toBe(true);
  expect(packageJson.peerDependenciesMeta['@earendil-works/pi-coding-agent']?.optional).toBe(true);
  expect(packageJson.peerDependenciesMeta['@earendil-works/pi-tui']?.optional).toBe(true);
  expect(fs.existsSync(path.join(appDir, 'node_modules', '@earendil-works', 'pi-coding-agent'))).toBe(false);
  expect(fs.existsSync(path.join(appDir, 'node_modules', '@earendil-works', 'pi-tui'))).toBe(false);

  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const core = await import('@nicknisi/pi-relay/core');
for (const name of ['deriveAddr', 'deposit', 'drain', 'claimInbox', 'recoverInboxClaims', 'readClaimedLetter', 'ackClaimedLetter', 'requeueClaimedLetter', 'claimAlias', 'pendingAsks', 'OutboundPolicy']) {
  if (typeof core[name] !== 'function') throw new Error(\`Missing core export: \${name}\`);
}
for (const name of ['recordPath', 'inboxDir', 'asksDir', 'aliasPath', 'auditLogPath', 'writeRecord', 'writeAlias', 'appendAudit']) {
  if (name in core) throw new Error(\`Internal helper escaped through /core: \${name}\`);
}
console.log('core-ok');`,
    ],
    { cwd: appDir, encoding: 'utf8' },
  );
  expect(output.trim()).toBe('core-ok');
}, 120_000);
