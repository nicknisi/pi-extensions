import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './host.test.js';
async function signedIn() {
  const f = await fixture();
  const { slug } = await (
    await f.upload({
      'index.html':
        '<title>Private title</title><link rel="stylesheet" href="nested/a.css"><script type="module" src="nested/a.js"></script><img src="nested/a.svg">',
      'nested/a.css': 'body{color:red}',
      'nested/a.js': 'document.body.dataset.loaded="yes"',
      'nested/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    })
  ).json();
  const mint = () =>
    f.api('/api/owner/viewing-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ return_path: `/${slug}/` }),
    });
  const ticket = await (await mint()).json();
  const confirmation = await fetch(ticket.url);
  // Chromium sends Origin: null for form POSTs from no-referrer documents.
  expect(confirmation.headers.get('referrer-policy')).toBe('same-origin');
  const login = await fetch(ticket.url, { method: 'POST', headers: { Origin: f.url }, redirect: 'manual' });
  expect(login.status).toBe(303);
  expect(login.headers.get('location')).toBe(`/${slug}/`);
  const cookie = login.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');
  expect(cookie).not.toContain(f.token);
  const headers = { Cookie: cookie.split(';')[0]! };
  const viewer = await fetch(`${f.url}/${slug}/`, { headers });
  expect(viewer.headers.get('referrer-policy')).toBe('same-origin');
  const shell = await viewer.text();
  const capabilityPath = shell.match(/src="([^"]*\/_view\/[^"]+)"/)?.[1];
  expect(capabilityPath).toBeTruthy();
  return { ...f, slug, mint, ticket, headers, shell, capabilityPath: capabilityPath! };
}
it('isolates viewer credentials from all owner APIs and loads scoped nested assets', async () => {
  const f = await signedIn();
  expect(f.shell).toContain('Private title');
  expect(f.shell).toContain('read-only');
  expect(f.shell).toContain('credentialless');
  expect(f.shell).not.toContain(f.tokenSha256);
  const anonymous = await (await fetch(`${f.url}/${f.slug}/`)).text();
  expect(anonymous).not.toContain('Private title');
  for (const path of ['index.html', 'nested/a.css', 'nested/a.js', 'nested/a.svg']) {
    const response = await fetch(f.url + f.capabilityPath.replace('index.html', path));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  }
  for (const path of [
    '/api/upload',
    '/api/links',
    `/api/links/${f.slug}/versions`,
    `/api/links/${f.slug}/file`,
    `/api/links/${f.slug}/bookmark`,
  ])
    expect(
      (await fetch(f.url + path, { method: path === '/api/links' ? 'GET' : 'POST', headers: f.headers })).status,
    ).toBe(401);
  expect((await fetch(f.ticket.url, { method: 'POST', headers: { Origin: f.url }, redirect: 'manual' })).status).toBe(
    401,
  );
  // A read capability must not reach the wrapper, which can mint new capabilities.
  for (const method of ['GET', 'HEAD'])
    expect((await fetch(f.url + f.capabilityPath.replace('index.html', ''), { method })).status).toBe(404);
  expect((await fetch(f.url + f.capabilityPath.replace('index.html', '.versions/1/index.html'))).status).toBe(404);
  const other = await (await f.upload()).json();
  expect((await fetch(f.url + f.capabilityPath.replace(f.slug, other.slug))).status).toBe(404);
  await f.upload({ 'index.html': 'replacement' }, `/api/links/${f.slug}/file`);
  expect((await fetch(f.url + f.capabilityPath)).status).toBe(404);
});
it('requires same-origin sign-in/logout, revokes capabilities on logout and expiry', async () => {
  const f = await signedIn();
  expect(
    (await fetch(f.url + '/owner/logout', { method: 'POST', headers: { ...f.headers, Origin: 'https://evil.test' } }))
      .status,
  ).toBe(403);
  expect(
    (
      await fetch(f.url + '/owner/logout', {
        method: 'POST',
        headers: { ...f.headers, Origin: f.url },
        redirect: 'manual',
      })
    ).status,
  ).toBe(303);
  const landing = await fetch(f.url + '/');
  expect(landing.status).toBe(200);
  expect(await landing.text()).toContain('Use the configured Pi Share menu');
  expect((await fetch(f.url + f.capabilityPath)).status).toBe(404);
  expect((await fetch(`${f.url}/${f.slug}/`, { headers: f.headers })).status).toBe(401);
  const ticket = await (await f.mint()).json();
  const db = new DatabaseSync(join(f.dataDir, 'artifacts.sqlite'));
  db.exec('UPDATE viewing_tickets SET expires=0');
  db.close();
  expect((await fetch(ticket.url, { method: 'POST', headers: { Origin: f.url }, redirect: 'manual' })).status).toBe(
    401,
  );
});
it('expires sessions/capabilities and invalidates auth on owner token rotation', async () => {
  const f = await signedIn();
  const db = new DatabaseSync(join(f.dataDir, 'artifacts.sqlite'));
  db.exec('UPDATE viewing_sessions SET expires=0');
  db.close();
  expect((await fetch(f.url + f.capabilityPath)).status).toBe(404);
  await f.host.close();
  const { startHost } = await import('./host.js');
  const rotated = await startHost({ dataDir: f.dataDir, tokenSha256: 'a'.repeat(64), port: 0 });
  f.cleanup.push(rotated.close);
  expect((await fetch(rotated.origin + `/${f.slug}/`, { headers: f.headers })).status).toBe(401);
  expect((await fetch(rotated.origin + '/api/links', { headers: { Authorization: `Bearer ${f.token}` } })).status).toBe(
    401,
  );
});
