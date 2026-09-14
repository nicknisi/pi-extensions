import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './host.test.js';
import { FILE_LIMIT } from './uploads.js';
it('A1-A10/A15: independent multipart, metadata, bookmarks, pagination, history and restore consumers', async () => {
  const f = await fixture();
  const upload = await f.upload({ 'index.html': '<title>Extracted</title>one', 'assets/a.css': 'body{color:red}' });
  const first = await upload.json();
  expect(first.url).toBe(`${f.url}/${first.slug}/`);
  const slug = first.slug;
  const list = await (await f.api('/api/links', { headers: { 'X-User-Email': 'forged@evil.test' } })).json();
  expect(list.current_user_email).toBe('owner@example.test');
  expect(list.uploads[0]).toMatchObject({
    slug,
    title: 'Extracted',
    is_public: false,
    is_bookmarked: false,
    uploader_email: 'owner@example.test',
    original_filename: 'index.html',
  });
  for (const key of ['created_at', 'updated_at']) expect(typeof list.uploads[0]![key]).toBe('string');
  await f.api(`/api/links/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Custom', is_public: true }),
  });
  for (const method of ['POST', 'POST', 'DELETE', 'DELETE'])
    expect(await (await f.api(`/api/links/${slug}/bookmark`, { method })).json()).toEqual({
      ok: true,
      is_bookmarked: method === 'POST',
    });
  expect(
    (
      await f.upload(
        { 'index.html': '<title>New</title>two', 'nested/a.js': 'export default 1' },
        `/api/links/${slug}/file`,
      )
    ).status,
  ).toBe(200);
  const history = await (await f.api(`/api/links/${slug}/versions`)).json();
  expect(history.current_version).toBe(2);
  expect(history.versions).toHaveLength(1);
  expect(history.versions[0]).toMatchObject({
    slug,
    version: 1,
    original_filename: 'index.html',
    file_count: 2,
    title: 'Custom',
    archived_by: 'owner@example.test',
    prefix: `${slug}/versions/1/`,
  });
  expect(typeof history.versions[0]!.archived_at).toBe('string');
  const restored = await (await f.api(`/api/links/${slug}/versions/1/restore`, { method: 'POST' })).json();
  expect(restored).toMatchObject({ ok: true, slug, current_version: 3, url: first.url });
  expect(await (await fetch(first.url + 'assets/a.css')).text()).toBe('body{color:red}');
  expect((await fetch(first.url + 'nested/a.js')).status).toBe(404);
  const recent = await (await f.api('/api/recent?scope=mine&page=999&pageSize=10')).json();
  expect(recent).toMatchObject({
    total: 1,
    page: 1,
    pageSize: 10,
    scope: 'mine',
    current_user_email: 'owner@example.test',
  });
  expect(recent.uploads[0]).toMatchObject({ title: 'Custom', current_version: 3, comment_count: 0, is_public: true });
  const head = await fetch(first.url + 'index.html', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect((await f.api(`/api/links/${slug}`, { method: 'DELETE' })).status).toBe(200);
  expect((await fetch(first.url)).status).toBe(404);
  expect((await (await f.api('/api/links')).json()).uploads).toEqual([]);
});
it('rolls back failed replacements and rejects storage/history excess before mutation', async () => {
  const f = await fixture();
  const { slug } = await (await f.upload()).json();
  await f.makePublic(slug);
  const db = new DatabaseSync(join(f.dataDir, 'artifacts.sqlite'));
  db.exec("CREATE TRIGGER fail_file BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
  expect((await f.upload({ 'index.html': 'lost' }, `/api/links/${slug}/file`)).status).toBe(500);
  expect((await (await f.api(`/api/links/${slug}/versions`)).json()).current_version).toBe(1);
  expect(await (await fetch(`${f.url}/${slug}/index.html`)).text()).toContain('Hello');
  db.exec('DROP TRIGGER fail_file');
  db.close();
});
it('accepts 25 MiB file bytes and rejects excess, duplicate paths and mismatched path counts', async () => {
  const f = await fixture();
  expect((await f.upload({ 'index.html': new Uint8Array(FILE_LIMIT) })).status).toBe(200);
  expect((await f.upload({ 'index.html': new Uint8Array(FILE_LIMIT + 1) })).status).toBe(413);
  for (const paths of [['index.html', 'index.html'], ['index.html']]) {
    const form = new FormData();
    form.append('files', new Blob(['one']), 'one.html');
    form.append('files', new Blob(['two']), 'two.html');
    form.append('paths', JSON.stringify(paths));
    expect((await f.api('/api/upload', { method: 'POST', body: form })).status).toBe(400);
  }
}, 15000);
