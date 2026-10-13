import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from './core.js';

const fixtures: string[] = [];

function relayRoot(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-relay-registration-')));
  fixtures.push(dir);
  return path.join(dir, 'relay');
}

const host = { sessionId: 'riker-supervisor', name: 'riker', cwd: '/work/riker' };

afterEach(() => {
  vi.useRealTimers();
  while (fixtures.length > 0) fs.rmSync(fixtures.pop()!, { recursive: true, force: true });
});

describe('/core session registration', () => {
  it('registers a live session visible in listRecords', () => {
    const root = relayRoot();
    const record = core.register(root, host);

    expect(record).toMatchObject({
      addr: core.deriveAddr(host.cwd, host.sessionId),
      sessionId: host.sessionId,
      name: 'riker',
      cwd: host.cwd,
      pid: process.pid,
      status: 'idle',
    });
    expect(record.startedAt).toBe(record.lastSeenAt);
    expect(core.listRecords(root)).toEqual([record]);
    expect(core.presenceOf(record)).toBe('live');
  });

  it('heartbeat refreshes lastSeenAt and applies the patch; unknown addresses stay unknown', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const root = relayRoot();
    const { addr } = core.register(root, host);

    vi.setSystemTime(1_015_000);
    const beat = core.heartbeat(root, addr, { status: 'working', name: 'riker-2' });
    expect(beat).toMatchObject({
      addr,
      lastSeenAt: 1_015_000,
      startedAt: 1_000_000,
      status: 'working',
      name: 'riker-2',
    });
    expect(core.readRecord(root, addr)).toEqual(beat);

    const unknown = core.deriveAddr('/nowhere', 'ghost');
    expect(core.heartbeat(root, unknown)).toBeNull();
    expect(core.readRecord(root, unknown)).toBeNull();
    expect(core.listRecords(root)).toHaveLength(1);
  });

  it('keeps a heartbeating session alias through sweep, and sweep clears it after unregister', () => {
    const root = relayRoot();
    const { addr } = core.register(root, host);
    core.claimAlias(root, 'riker', addr, host.sessionId);

    core.heartbeat(root, addr);
    core.sweep(root);
    expect(core.readAlias(root, 'riker')).toMatchObject({ addr });

    core.unregister(root, addr);
    expect(core.listRecords(root)).toEqual([]);
    core.sweep(root);
    expect(core.readAlias(root, 'riker')).toBeNull();
    expect(() => core.unregister(root, addr)).not.toThrow();
  });

  it('re-registering keeps addr and startedAt', () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const root = relayRoot();
    const first = core.register(root, host);

    vi.setSystemTime(2_060_000);
    const second = core.register(root, { ...host, name: 'renamed', status: 'working' });
    expect(second).toMatchObject({ addr: first.addr, startedAt: 2_000_000, lastSeenAt: 2_060_000, name: 'renamed' });
    expect(core.listRecords(root)).toEqual([second]);
  });

  it('rejects invalid input', () => {
    const root = relayRoot();
    const { addr } = core.register(root, host);
    const calls = [
      () => core.register(root, { ...host, sessionId: '' }),
      () => core.register(root, { ...host, name: 42 as unknown as string }),
      () => core.register(root, { ...host, cwd: '' }),
      () => core.register(root, { ...host, pid: 0 }),
      () => core.register(root, { ...host, pid: 1.5 }),
      () => core.register(root, { ...host, status: 'busy' as 'idle' }),
      () => core.heartbeat(root, '../../escaped'),
      () => core.heartbeat(root, addr, { status: 'busy' as 'idle' }),
      () => core.heartbeat(root, addr, { name: '' }),
      () => core.unregister(root, '../../escaped'),
    ];
    for (const call of calls) expect(call).toThrow(TypeError);
  });
});
