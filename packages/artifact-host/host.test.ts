import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startHost } from './host.js';
interface Wire {
  slug: string;
  url: string;
  current_user_email: string;
  current_version: number;
  is_public: boolean;
  uploads: Wire[];
  versions: Wire[];
  archived_at: string;
  [key: string]: unknown;
}
type WireResponse = Omit<Response, 'json'> & { json(): Promise<Wire> };
const token = 'fixture-owner-token-not-a-secret-123456';
const tokenSha256 = createHash('sha256').update(token).digest('hex');
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
export async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'artifact-host-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const host = await startHost({ dataDir, tokenSha256, port: 0, ownerEmail: 'owner@example.test' });
  cleanup.push(host.close);
  const url = host.origin;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    }) as Promise<WireResponse>;
  const upload = (
    files: Record<string, string | Uint8Array> = { 'hello.html': '<title>Hello</title><h1>Hello</h1>' },
    path = '/api/upload',
    headers: Record<string, string> = {},
    title?: string,
  ) => {
    const form = new FormData();
    for (const [name, bytes] of Object.entries(files))
      form.append(
        'files',
        new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)]),
        name.split('/').at(-1),
      );
    form.append('paths', JSON.stringify(Object.keys(files)));
    if (title !== undefined) form.append('title', title);
    return api(path, { method: 'POST', headers, body: form });
  };
  const makePublic = (slug: string) =>
    api(`/api/links/${slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_public: true }),
    });
  return { host, url, api, upload, makePublic, dataDir, tokenSha256, token, cleanup };
}
describe('real HTTP host', () => {
  it('fails closed on invalid configuration and preserves old development databases', async () => {
    await expect(startHost({ dataDir: '/unused', tokenSha256: '' })).rejects.toThrow('hash');
    const f = await fixture();
    await f.host.close();
    const db = new DatabaseSync(join(f.dataDir, 'artifacts.sqlite'));
    db.exec('PRAGMA user_version=0');
    db.close();
    await expect(startHost({ dataDir: f.dataDir, tokenSha256, port: 0 })).rejects.toThrow(
      'Existing data was not removed',
    );
  });
  it('authenticates multipart, persists and guards replacement atomically', async () => {
    const f = await fixture();
    expect((await fetch(f.url + '/api/upload', { method: 'POST' })).status).toBe(401);
    const first = await f.upload(undefined, undefined, { 'Idempotency-Key': 'first', 'If-Match': '"0"' });
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe('"1"');
    const b = await first.json();
    expect(b.slug).toMatch(/^[a-z0-9]{8,16}$/);
    expect(b.is_public).toBe(false);
    expect(
      (await (await f.upload(undefined, undefined, { 'Idempotency-Key': 'first', 'If-Match': '"0"' })).json()).slug,
    ).toBe(b.slug);
    await f.makePublic(b.slug);
    const responses = await Promise.all([
      f.upload({ 'index.html': 'new' }, `/api/links/${b.slug}/file`, { 'If-Match': '"1"' }),
      f.upload({ 'index.html': 'stale' }, `/api/links/${b.slug}/file`, { 'If-Match': '"1"' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 412]);
    await f.host.close();
    const host = await startHost({ dataDir: f.dataDir, tokenSha256, port: 0 });
    cleanup.push(host.close);
    expect(await (await fetch(host.origin + `/${b.slug}/index.html`)).text()).toBe('new');
  });
  it('rejects unsafe paths, malformed multipart and spoofed identity', async () => {
    const f = await fixture();
    for (const path of [
      '../index.html',
      'a/../index.html',
      '.versions/index.html',
      'a\\index.html',
      '/index.html',
      'a%2findex.html',
    ])
      expect((await f.upload({ [path]: 'bad' })).status).toBe(400);
    expect(
      (
        await f.api('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data; boundary=bad' },
          body: 'broken',
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(f.url + '/api/links', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' } }))
        .status,
    ).toBe(401);
    expect((await fetch(f.url + '/artifacts.sqlite')).status).toBe(404);
  });
});
