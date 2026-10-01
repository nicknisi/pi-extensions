import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ackClaimedLetter, awaitReceipt, claimInbox, deposit, sweepAcknowledgements, type Letter } from './mailbox.js';
import { deriveAddr, sweep, SWEEP_MAIL_KEEP_MS, writeRecord } from './registry.js';
import { openRelayRoot, RelayDirectoryHandle } from './filesystem.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-receipt-')));
  roots.push(root);
  return root;
}
const addr = deriveAddr('/receiver', 'receiver');
function letter(id = 'proof', ts = Date.now()): Letter {
  return {
    id,
    ts,
    kind: 'message',
    body: 'fixture',
    from: { addr: deriveAddr('/sender', 'sender'), name: 'sender', cwd: '/sender' },
  };
}

it('does not infer delivery from absent roots, removed letters, or legacy roots without ACKs', async () => {
  const root = fixture();
  const l = letter();
  expect(await awaitReceipt(path.join(root, 'absent'), addr, l, 0)).toBe('uncertain');
  deposit(root, addr, l);
  expect(await awaitReceipt(root, addr, l, 0)).toBe('queued');
  fs.unlinkSync(path.join(root, `${addr}.inbox`, `${l.ts}-${l.id}.json`));
  expect(await awaitReceipt(root, addr, l, 0)).toBe('uncertain');
});

it('persists exact proof before deletion and cleans empty claims on Linux and macOS', async () => {
  const root = fixture();
  const l = letter();
  deposit(root, addr, l);
  const claim = claimInbox(root, addr)!;
  expect(await awaitReceipt(root, addr, l, 0)).toBe('queued');
  expect(ackClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)).toBe(true);
  expect(fs.existsSync(path.join(root, `${addr}.claims`, claim.claimToken))).toBe(false);
  expect(await awaitReceipt(root, addr, l, 0)).toBe('delivered');
  expect(await awaitReceipt(root, addr, { ...l, id: 'different' }, 0)).toBe('uncertain');
  expect(await awaitReceipt(root, addr, { ...l, body: 'changed payload' }, 0)).toBe('uncertain');
  expect(await awaitReceipt(root, addr, { ...l, from: { ...l.from, addr: deriveAddr('/other', 'other') } }, 0)).toBe(
    'uncertain',
  );
  expect(ackClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)).toBe(false);
});

it('keeps mail claimed if the ACK path is unsafe, without writing through symlinks', async () => {
  const root = fixture();
  const outside = fixture();
  const l = letter();
  deposit(root, addr, l);
  const claim = claimInbox(root, addr)!;
  fs.symlinkSync(outside, path.join(root, `${addr}.acks`));
  expect(() => ackClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)).toThrow(/symlink/i);
  expect(fs.existsSync(path.join(root, `${addr}.claims`, claim.claimToken, claim.fileTokens[0]!))).toBe(true);
  expect(fs.readdirSync(outside)).toEqual([]);
  await expect(awaitReceipt(root, addr, l, 0)).rejects.toThrow(/symlink/i);
});

it('does not grant delivery proof to corrupt or mismatched payloads', async () => {
  const root = fixture();
  const l = letter();
  deposit(root, addr, l);
  const claim = claimInbox(root, addr)!;
  fs.writeFileSync(path.join(root, `${addr}.claims`, claim.claimToken, claim.fileTokens[0]!), '{bad');
  ackClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!);
  expect(await awaitReceipt(root, addr, l, 0)).toBe('uncertain');
});

it('preserves claimed mail when persisting proof fails and supports a successful retry', async () => {
  const root = fixture();
  const l = letter();
  deposit(root, addr, l);
  const claim = claimInbox(root, addr)!;
  const write = vi.spyOn(RelayDirectoryHandle.prototype, 'writeFileAtomic').mockImplementationOnce(() => {
    throw new Error('fixture proof write failed');
  });
  try {
    expect(() => ackClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)).toThrow(/proof write failed/);
    expect(fs.existsSync(path.join(root, `${addr}.claims`, claim.claimToken, claim.fileTokens[0]!))).toBe(true);
    expect(await awaitReceipt(root, addr, l, 0)).toBe('queued');
  } finally {
    write.mockRestore();
  }
  expect(ackClaimedLetter(root, addr, claim.claimToken, claim.fileTokens[0]!)).toBe(true);
  expect(await awaitReceipt(root, addr, l, 0)).toBe('delivered');
});

it('rejects symlinked proof files without reading their targets', async () => {
  const root = fixture();
  const outside = fixture();
  const l = letter();
  deposit(root, addr, l);
  const claim = claimInbox(root, addr)!;
  const token = claim.fileTokens[0]!;
  ackClaimedLetter(root, addr, claim.claimToken, token);
  const proofPath = path.join(root, `${addr}.acks`, token);
  const outsideFile = path.join(outside, 'fixture-proof');
  fs.writeFileSync(outsideFile, fs.readFileSync(proofPath));
  fs.unlinkSync(proofPath);
  fs.symlinkSync(outsideFile, proofPath);
  await expect(awaitReceipt(root, addr, l, 0)).rejects.toThrow(/symlink/i);
});

it('expires proof for live sessions, retains malformed markers, and protects recent proof during sweep', () => {
  const root = fixture();
  const now = Date.now();
  const old = letter('old', now - SWEEP_MAIL_KEEP_MS - 1);
  const recent = letter('recent', now);
  for (const l of [old, recent]) deposit(root, addr, l);
  const claim = claimInbox(root, addr)!;
  for (const token of claim.fileTokens) ackClaimedLetter(root, addr, claim.claimToken, token);
  const oldProofPath = path.join(root, `${addr}.acks`, `${old.ts}-${old.id}.json`);
  const recentProofPath = path.join(root, `${addr}.acks`, `${recent.ts}-${recent.id}.json`);
  // Retention starts at acknowledgement, not at the timestamp of long-queued mail.
  const oldProof = JSON.parse(fs.readFileSync(oldProofPath, 'utf8'));
  expect(oldProof.acknowledgedAt).toBeGreaterThanOrEqual(now);
  fs.writeFileSync(oldProofPath, JSON.stringify({ ...oldProof, acknowledgedAt: now - SWEEP_MAIL_KEEP_MS - 1 }));
  const recentProof = JSON.parse(fs.readFileSync(recentProofPath, 'utf8'));
  fs.writeFileSync(recentProofPath, JSON.stringify({ ...recentProof, acknowledgedAt: now }));
  writeRecord(root, {
    addr,
    sessionId: 'receiver',
    name: 'receiver',
    cwd: '/receiver',
    pid: process.pid,
    startedAt: now,
    lastSeenAt: now,
    status: 'idle',
  });
  sweep(root, now);
  expect(fs.readdirSync(path.join(root, `${addr}.acks`))).toEqual([`${recent.ts}-${recent.id}.json`]);
  writeRecord(root, {
    addr,
    sessionId: 'receiver',
    name: 'receiver',
    cwd: '/receiver',
    pid: process.pid,
    startedAt: now,
    lastSeenAt: now - 60_000,
    status: 'idle',
    offline: true,
  });
  sweep(root, now, () => false);
  expect(fs.existsSync(path.join(root, `${addr}.json`))).toBe(true);
  fs.writeFileSync(path.join(root, `${addr}.acks`, 'malformed.json'), 'not proof');
  expect(sweepAcknowledgements(root, addr, now + SWEEP_MAIL_KEEP_MS + 1, SWEEP_MAIL_KEEP_MS)).toBe(1);
});

it('never lets retained proof pin an expired offline record', () => {
  const root = fixture();
  const now = Date.now();
  writeRecord(root, {
    addr,
    sessionId: 'receiver',
    name: 'receiver',
    cwd: '/receiver',
    pid: process.pid,
    startedAt: 0,
    lastSeenAt: now - SWEEP_MAIL_KEEP_MS - 1,
    status: 'idle',
    offline: true,
  });
  fs.mkdirSync(path.join(root, `${addr}.acks`));
  fs.writeFileSync(path.join(root, `${addr}.acks`, 'malformed.json'), 'not proof');
  sweep(root, now, () => true);
  expect(fs.existsSync(path.join(root, `${addr}.json`))).toBe(false);
  expect(fs.existsSync(path.join(root, `${addr}.acks`))).toBe(false);
});

it('uses the platform directory-removal flag for descriptor-relative cleanup', () => {
  const root = fixture();
  const handle = openRelayRoot(root)!;
  try {
    handle.openDirectory('empty', true)!.close();
    expect(handle.removeEmptyDirectory('empty')).toBe(true);
    expect(fs.existsSync(path.join(root, 'empty'))).toBe(false);
  } finally {
    handle.close();
  }
});
