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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-relay-core-'));
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

  it('rejects traversal in aliases and ask/message identifiers', async () => {
    const base = fixture();
    const root = path.join(base, 'relay');
    const addr = core.deriveAddr('/receiver', 'session');
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
for (const name of ['deriveAddr', 'deposit', 'drain', 'claimAlias', 'pendingAsks', 'OutboundPolicy']) {
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
