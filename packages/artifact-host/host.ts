import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { COOKIE, ViewingAuth } from './auth.js';
import { HttpError, multipart, readJson, safePath, SLUG, mime, FILE_LIMIT } from './uploads.js';
import { contentHeaders, shellHeaders, viewer, signIn } from './view.js';

export interface HostConfig {
  dataDir: string;
  tokenSha256: string;
  host?: string;
  port?: number;
  canonicalUrl?: string | undefined;
  ownerEmail?: string | undefined;
}
export const HTML_LIMIT = FILE_LIMIT;
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
export function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid canonical URL');
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !/^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?\/?$/.test(value))
  )
    throw new Error('Canonical URL must be an HTTPS origin, or literal loopback HTTP for development');
  return url.origin;
}
/** One process per directory. Importing the host opens no resources. */
export async function startHost(config: HostConfig) {
  if (!/^[a-fA-F0-9]{64}$/.test(config.tokenSha256)) throw new Error('A valid owner token SHA-256 hash is required');
  if (!Number.isInteger(config.port ?? 8080) || (config.port ?? 8080) < 0 || (config.port ?? 8080) > 65535)
    throw new Error('Invalid port');
  const bind = config.host ?? '127.0.0.1';
  if (!config.canonicalUrl && !['127.0.0.1', '::1'].includes(bind))
    throw new Error('Non-loopback listeners require an HTTPS canonical URL');
  let origin = config.canonicalUrl ? canonicalOrigin(config.canonicalUrl) : '';
  if (!['127.0.0.1', '::1'].includes(bind) && !origin.startsWith('https:'))
    throw new Error('Non-loopback listeners require HTTPS');
  const owner = config.ownerEmail ?? 'owner@localhost';
  if (!/^[^\s@]+@[^\s@]+$/.test(owner) || owner.length > 254) throw new Error('Invalid owner email');
  const digest = Buffer.from(config.tokenSha256, 'hex');
  const store = new Store(config.dataDir, owner);
  const viewing = new ViewingAuth(store, config.tokenSha256.toLowerCase());
  const isOwner = (req: IncomingMessage) => {
    const token = /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(req.headers.authorization ?? '')?.[1];
    return !!token && timingSafeEqual(createHash('sha256').update(token).digest(), digest);
  };
  let activeBodies = 0;
  let rateStart = Date.now(),
    rateCount = 0;
  const server = createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    void handle(req, res).catch((e) => {
      if (!res.headersSent)
        json(res, e instanceof HttpError ? e.status : 500, {
          error: e instanceof HttpError ? e.message : 'Request failed',
        });
      else res.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 100;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const raw = (req.url ?? '/').split('?')[0]!;
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, 'Invalid path');
    }
    if (path.includes('\\') || path.split('/').some((p) => p === '.' || p === '..') || path.includes('%'))
      throw new HttpError(400, 'Invalid path');
    const query = new URLSearchParams((req.url ?? '').split('?')[1]);
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, shellHeaders);
      return res.end(req.method === 'HEAD' ? undefined : signIn());
    }
    if (path === '/owner/sign-in' && req.method === 'GET') {
      // The ticket is an explicit top-level sign-in navigation, never a framed mutation.
      if (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document')
        throw new HttpError(403, 'Top-level sign-in required');
      const ticket = query.get('ticket') ?? '';
      if (!/^[a-f0-9]{64}$/.test(ticket)) throw new HttpError(401, 'Invalid or expired sign-in');
      // Confirmation POST makes sign-in same-origin and prevents cross-site forms consuming tickets.
      res.writeHead(200, shellHeaders);
      return res.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Read-only sign-in</title><h1>Read-only sign-in</h1><p>This session permits private viewing, not publication or management.</p><form method="post" action="/owner/sign-in?ticket=${ticket}"><button>Sign in for viewing</button></form></html>`,
      );
    }
    if ((path === '/owner/sign-in' || path === '/owner/logout') && req.method === 'POST') {
      if (req.headers.origin !== origin) throw new HttpError(403, 'Same-origin request required');
      if (path === '/owner/logout') {
        viewing.logout(req);
        res.writeHead(303, {
          Location: '/',
          'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${origin.startsWith('https:') ? '; Secure' : ''}`,
        });
        return res.end();
      }
      const session = viewing.consume(query.get('ticket') ?? '');
      res.writeHead(303, {
        Location: session.target,
        'Set-Cookie': `${COOKIE}=${session.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${origin.startsWith('https:') ? '; Secure' : ''}`,
      });
      return res.end();
    }
    if (path.startsWith('/api/')) {
      if (!isOwner(req)) throw new HttpError(401, 'Unauthorized');
      if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Origin denied');
      if (Date.now() - rateStart > 60000) {
        rateStart = Date.now();
        rateCount = 0;
      }
      if (++rateCount > 600) throw new HttpError(429, 'Request rate limit');
      if (path === '/api/owner/viewing-tickets' && req.method === 'POST') {
        const body = await readJson(req);
        const ticket = viewing.ticket(body.return_path);
        return json(res, 200, { url: `${origin}/owner/sign-in?ticket=${ticket}`, expires_in: 60 });
      }
      const link = /^\/api\/links\/([a-z0-9]{8,16})(.*)$/.exec(path);
      if (req.method === 'POST' && (path === '/api/upload' || link?.[2] === '/file')) {
        if (activeBodies >= 4) throw new HttpError(429, 'Upload concurrency limit');
        const key = req.headers['idempotency-key'];
        const match = req.headers['if-match'];
        if (
          (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key))) ||
          (match !== undefined && !/^"\d+"$/.test(match))
        )
          throw new HttpError(400, 'Invalid guard');
        activeBodies++;
        try {
          const upload = await multipart(req);
          const result = store.publish(upload, link?.[1], match, key as string | undefined);
          res.setHeader('ETag', `"${result.current_version}"`);
          return json(res, 200, { ...(link ? { ok: true } : {}), ...result, url: `${origin}/${result.slug}/` });
        } finally {
          activeBodies--;
        }
      }
      if (req.method === 'GET' && (path === '/api/recent' || path === '/api/links')) {
        const uploads = store.list();
        if (path === '/api/links') return json(res, 200, { current_user_email: owner, uploads });
        const scope = query.get('scope') === 'mine' ? 'mine' : 'all';
        const pageSize = [10, 25, 100].includes(Number(query.get('pageSize'))) ? Number(query.get('pageSize')) : 25;
        const requested = Number(query.get('page') ?? 1);
        const page = Math.max(
          1,
          Math.min(Number.isSafeInteger(requested) ? requested : 1, Math.ceil(uploads.length / pageSize) || 1),
        );
        return json(res, 200, {
          current_user_email: owner,
          uploads: uploads.slice((page - 1) * pageSize, page * pageSize),
          total: uploads.length,
          page,
          pageSize,
          scope,
        });
      }
      if (link) {
        const slug = link[1]!,
          suffix = link[2];
        const row = store.get(slug);
        res.setHeader('ETag', `"${row.current_version}"`);
        if (suffix === '' && req.method === 'PATCH')
          return json(res, 200, store.patch(slug, await readJson(req), req.headers['if-match']));
        if (suffix === '' && req.method === 'GET')
          return json(res, 200, {
            ...row,
            is_public: !!row.is_public,
            is_bookmarked: !!row.is_bookmarked,
            uploader_email: owner,
            comment_count: 0,
          });
        if (suffix === '' && req.method === 'DELETE') {
          store.transaction(() => {
            store.guard(store.get(slug), req.headers['if-match']);
            store.db.prepare('DELETE FROM artifacts WHERE slug=?').run(slug);
          });
          return json(res, 200, { ok: true });
        }
        if (suffix === '/bookmark' && ['POST', 'DELETE'].includes(req.method ?? '')) {
          const value = req.method === 'POST';
          store.db.prepare('UPDATE artifacts SET is_bookmarked=? WHERE slug=?').run(Number(value), slug);
          return json(res, 200, { ok: true, is_bookmarked: value });
        }
        if (suffix === '/versions' && req.method === 'GET') return json(res, 200, store.versions(slug));
        const restore = /^\/versions\/([1-9]\d*)\/restore$/.exec(suffix!);
        if (restore && req.method === 'POST') {
          const result = store.restore(slug, Number(restore[1]), req.headers['if-match']);
          res.setHeader('ETag', `"${result.current_version}"`);
          return json(res, 200, { ok: true, ...result, url: `${origin}/${slug}/` });
        }
      }
      throw new HttpError(404, 'Not found');
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const parts = path.slice(1).split('/');
      const capability = parts[0] === '_view' ? (parts.shift(), parts.shift()) : undefined;
      const slug = parts.shift()!;
      if (SLUG.test(slug)) {
        const row = store.get(slug);
        const filePath = parts.join('/');
        const session = viewing.session(req);
        const capabilityAllowed = capability !== undefined && viewing.allows(capability, slug, row.current_version);
        if (capability !== undefined && (!filePath || !capabilityAllowed)) throw new HttpError(404, 'Not found');
        if (!row.is_public && !isOwner(req) && !capabilityAllowed && !(session && !filePath)) {
          if (!filePath) {
            res.writeHead(401, shellHeaders);
            return res.end(req.method === 'HEAD' ? undefined : signIn());
          }
          throw new HttpError(404, 'Not found');
        }
        if (!filePath) {
          const readCapability =
            !row.is_public && req.method !== 'HEAD'
              ? viewing.capability(session ?? viewing.newSession(), slug, row.current_version)
              : undefined;
          res.writeHead(200, shellHeaders);
          return res.end(req.method === 'HEAD' ? undefined : viewer(slug, row.title, readCapability));
        }
        if (!safePath(filePath)) throw new HttpError(404, 'Not found');
        const file = store.db
          .prepare('SELECT bytes FROM files WHERE slug=? AND version=? AND path=?')
          .get(slug, row.current_version, filePath);
        if (file) {
          res.writeHead(200, {
            ...contentHeaders,
            'Content-Type': mime(filePath),
            ...(row.is_public || capabilityAllowed ? { 'Access-Control-Allow-Origin': '*' } : {}),
          });
          return res.end(req.method === 'HEAD' ? undefined : Buffer.from(file.bytes as Uint8Array));
        }
      }
    }
    throw new HttpError(404, 'Not found');
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port ?? 8080, bind, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (e) {
    store.db.close();
    throw e;
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!origin) origin = `http://${bind === '::1' ? '[::1]' : bind}:${port}`;
  let closed: Promise<void> | undefined;
  return {
    port,
    origin,
    close: () =>
      (closed ??= new Promise<void>((resolve, reject) => {
        server.close((e) => {
          store.db.close();
          if (e) reject(e);
          else resolve();
        });
        server.closeAllConnections();
      })),
  };
}
