import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseRemoteConfig, publicationStatus, publishArtifact } from './remote.js';
const token = 'fixture-owner-token-not-a-secret-123456';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { startHost } = await import('../artifact-host/' + 'host.ts');
  const hostConfig = {
    dataDir: join(dir, 'db'),
    tokenSha256: createHash('sha256').update(token).digest('hex'),
    port: 0,
  };
  const host = await startHost(hostConfig);
  cleanups.push(host.close);
  const settings = parseRemoteConfig({ url: host.origin, tokenEnv: 'ARTIFACT_TEST_TOKEN' });
  vi.stubEnv('ARTIFACT_TEST_TOKEN', token);
  const path = join(dir, 'test.html');
  writeFileSync(path, '<title>Hello</title><p>first</p><script data-artifact-reload>local()</script>');
  const api = (path: string, init: RequestInit = {}) =>
    fetch(host.origin + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  return { dir, host, settings, path, map: join(dir, 'test.remote.json'), api, startHost, hostConfig };
}
describe('Drop publisher integrated path', () => {
  it('requires opt-in and validates origins without echoing input', () => {
    expect(parseRemoteConfig(undefined)).toEqual({});
    for (const url of [
      'http://example.com',
      'https://user:secret@example.com',
      'https://example.com/path',
      'https://example.com?secret',
      'https://example.com#secret',
    ]) {
      const result = parseRemoteConfig({ url, tokenEnv: 'TOKEN' });
      expect(result.remote).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('secret');
    }
    expect(parseRemoteConfig({ url: 'http://[::1]:123', tokenEnv: 'TOKEN' }).remote).toBeDefined();
  });
  it('publishes rendered multipart only on request, enables visibility and replaces a stable URL', async () => {
    const f = await setup();
    expect(publicationStatus(f.path, f.settings).state).toBe('unpublished');
    expect((await publishArtifact(f.path, f.settings, false)).state).toBe('unpublished');
    const first = await publishArtifact(f.path, f.settings);
    expect(first.state).toBe('synced');
    expect(await (await fetch(first.url + 'index.html')).text()).toBe('<title>Hello</title><p>first</p>');
    expect(readFileSync(f.map, 'utf8')).not.toContain(token);
    expect(readFileSync(f.map, 'utf8')).not.toContain('<title>');
    writeFileSync(f.path, '<title>Hello</title>newest');
    await Promise.all([publishArtifact(f.path, f.settings, false), publishArtifact(f.path, f.settings, false)]);
    expect(publicationStatus(f.path, f.settings).url).toBe(first.url);
    expect(await (await fetch(first.url + 'index.html')).text()).toContain('newest');
  });
  it('recovers a lost upload response after local edits without duplicate uploads', async () => {
    const f = await setup();
    const realFetch = globalThis.fetch;
    let lost = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      if (String(input).endsWith('/api/upload') && !lost) {
        lost = true;
        await response.body?.cancel();
        throw new Error('lost');
      }
      return response;
    });
    expect((await publishArtifact(f.path, f.settings)).state).toBe('unsynced');
    const operation = JSON.parse(readFileSync(f.map, 'utf8')).operation;
    expect(operation.key).toMatch(/^[a-f0-9]{32}$/);
    writeFileSync(f.path, 'new local edit');
    const result = await publishArtifact(f.path, f.settings);
    expect(result.state).toBe('synced');
    expect((await (await f.api('/api/links')).json()).uploads).toHaveLength(1);
    expect(await (await fetch(result.url + 'index.html')).text()).toBe('new local edit');
  });
  it('recovers lost visibility PATCH, keeps remotely revoked content private on auto-sync', async () => {
    const f = await setup();
    const realFetch = globalThis.fetch;
    let lost = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      if (init?.method === 'PATCH' && !lost) {
        lost = true;
        await response.body?.cancel();
        throw new Error('lost');
      }
      return response;
    });
    const failed = await publishArtifact(f.path, f.settings);
    expect(failed.state).toBe('unsynced');
    expect(failed.url).toBeUndefined();
    const slug = JSON.parse(readFileSync(f.map, 'utf8')).slug;
    expect((await publishArtifact(f.path, f.settings)).state).toBe('synced');
    await f.api(`/api/links/${slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"is_public":false}',
    });
    writeFileSync(f.path, 'private update');
    const privateResult = await publishArtifact(f.path, f.settings, false);
    expect(privateResult.url).toBeUndefined();
    expect(privateResult.error).toContain('private');
    expect((await fetch(privateResult.viewerUrl!)).status).toBe(401);
    expect((await publishArtifact(f.path, f.settings)).state).toBe('synced');
    expect((await (await f.api('/api/links')).json()).uploads).toHaveLength(1);
  });
  it('guards stale writers and only rebases on an explicit retry', async () => {
    const f = await setup();
    const first = await publishArtifact(f.path, f.settings);
    const stale = readFileSync(f.map, 'utf8');
    writeFileSync(f.path, 'new');
    await publishArtifact(f.path, f.settings);
    writeFileSync(f.map, stale);
    writeFileSync(f.path, 'stale');
    expect((await publishArtifact(f.path, f.settings, false)).error).toContain('conflict');
    expect(await (await fetch(first.url + 'index.html')).text()).toBe('new');
    writeFileSync(f.path, 'current explicit');
    expect((await publishArtifact(f.path, f.settings)).state).toBe('synced');
    expect(await (await fetch(first.url + 'index.html')).text()).toBe('current explicit');
  });
  it('preserves old mappings and local edits during outages and restarts', async () => {
    const f = await setup();
    await publishArtifact(f.path, f.settings);
    const before = readFileSync(f.map, 'utf8');
    const changed = parseRemoteConfig({ url: 'https://example.com', tokenEnv: 'TOKEN' });
    expect((await publishArtifact(f.path, changed, false)).warning).toContain('old public copy');
    expect(readFileSync(f.map, 'utf8')).toBe(before);
    await f.host.close();
    writeFileSync(f.path, 'offline local content');
    expect((await publishArtifact(f.path, f.settings, false)).state).toBe('unsynced');
    expect(readFileSync(f.path, 'utf8')).toBe('offline local content');
    const reopened = await f.startHost({ ...f.hostConfig, port: f.host.port });
    cleanups.push(reopened.close);
    expect((await publishArtifact(f.path, f.settings)).state).toBe('synced');
    writeFileSync(f.map, '{"version":1,"id":"old"}');
    expect((await publishArtifact(f.path, f.settings)).error).toContain('mapping');
    expect(readFileSync(f.map, 'utf8')).toBe('{"version":1,"id":"old"}');
  });
  it('redacts denied, redirected, malformed and oversized responses', async () => {
    const f = await setup();
    for (const response of [
      new Response(token, { status: 401 }),
      new Response(token, { status: 307 }),
      new Response('x'.repeat(17000)),
      new Response(JSON.stringify({ error: token })),
    ]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
      const result = await publishArtifact(f.path, f.settings);
      expect(result.state).toBe('unsynced');
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });
});
