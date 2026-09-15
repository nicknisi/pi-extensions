/** Drop-compatible owner transport. Credentials are resolved only at request time. */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
export interface RemoteConfig {
  url: string;
  tokenEnv: string;
  autoSync: boolean;
}
export interface RemoteSettings {
  remote?: RemoteConfig;
  remoteError?: string;
}
export function parseRemoteConfig(value: unknown): RemoteSettings {
  if (value === undefined) return {};
  try {
    const c = value as Record<string, unknown>;
    if (
      !c ||
      typeof c.url !== 'string' ||
      typeof c.tokenEnv !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.tokenEnv) ||
      (c.autoSync !== undefined && typeof c.autoSync !== 'boolean')
    )
      throw new Error();
    const url = new URL(c.url);
    const loopback = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(c.url);
    if (
      (url.protocol !== 'https:' && !loopback) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      c.url.includes('?') ||
      c.url.includes('#')
    )
      throw new Error();
    return { remote: { url: url.origin, tokenEnv: c.tokenEnv, autoSync: c.autoSync !== false } };
  } catch {
    return {
      remoteError: 'Invalid remote configuration in artifacts.json. Use an HTTPS origin and tokenEnv variable name.',
    };
  }
}
const errors = {
  credentials: 'Missing or invalid publishing credential. Check the configured environment variable.',
  network: 'Host unavailable, timed out, redirected, or returned an invalid response. Retry explicitly.',
  denied: 'Publishing denied. Check the configured credential.',
  conflict:
    'Remote version conflict. Retry explicitly to replace the latest remote version with current local content.',
  storage: 'Could not save publication metadata. Local content is intact. Retry explicitly.',
  mapping:
    'Incompatible or unreadable publication mapping. Back up and move aside the .remote.json file, then explicitly publish again. No saved data was removed.',
  changed: 'Host changed. Explicit publication creates a new link. The old public copy and a backup mapping remain.',
  busy: 'Another publisher holds the .remote.json.lock directory. Retry when it finishes. After a crash, remove only that empty lock directory to recover the saved operation.',
  private: 'The hosted artifact is private. Explicitly Publish link to make it public again.',
} as const;
type ErrorCode = keyof typeof errors;
interface Operation {
  key: string;
  digest: string;
  title: string;
  revision: number;
}
interface Mapping {
  version: 2;
  origin: string;
  slug?: string;
  revision: number;
  digest: string;
  isPublic: boolean;
  published: boolean;
  state: 'synced' | 'unsynced';
  operation?: Operation;
  error?: ErrorCode;
}
export interface RemoteStatus {
  enabled: boolean;
  state: 'unpublished' | 'synced' | 'unsynced' | 'disabled';
  url?: string;
  viewerUrl?: string;
  isPublic?: boolean;
  error?: string;
  warning?: string;
}
const queues = new Map<string, Promise<unknown>>();
const mappingPath = (path: string) => path.replace(/\.html$/, '') + '.remote.json';
function readMapping(path: string): Mapping | null {
  let raw: string;
  try {
    if (statSync(path).size > 16384) throw new Error();
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(errors.mapping);
  }
  try {
    const m = JSON.parse(raw) as Mapping;
    if (
      m.version !== 2 ||
      (m.slug !== undefined && !/^[a-z0-9]{8,16}$/.test(m.slug)) ||
      !Number.isSafeInteger(m.revision) ||
      m.revision < 0 ||
      !/^(?:[a-f0-9]{64})?$/.test(m.digest) ||
      typeof m.isPublic !== 'boolean' ||
      typeof m.published !== 'boolean' ||
      !['synced', 'unsynced'].includes(m.state) ||
      (m.error !== undefined && !Object.hasOwn(errors, m.error)) ||
      (m.operation !== undefined &&
        (!/^[a-f0-9]{32}$/.test(m.operation.key) ||
          !/^[a-f0-9]{64}$/.test(m.operation.digest) ||
          typeof m.operation.title !== 'string' ||
          !Number.isSafeInteger(m.operation.revision) ||
          m.operation.revision < 0)) ||
      parseRemoteConfig({ url: m.origin, tokenEnv: 'TOKEN' }).remote?.url !== m.origin
    )
      throw new Error();
    return m;
  } catch {
    throw new Error(errors.mapping);
  }
}
function save(path: string, mapping: Mapping, initial = false) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(mapping), { mode: 0o600, flag: 'wx', flush: true });
    if (initial) linkSync(temp, path);
    else renameSync(temp, path);
    const fd = openSync(dirname(path), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
function snapshot(path: string) {
  if (statSync(path).size > 6 * 1024 * 1024) throw new Error();
  const html = readFileSync(path, 'utf8').replace(/<script data-artifact-reload>[\s\S]*?<\/script>/gi, '');
  const title = (html.match(/<title>(.*?)<\/title>/s)?.[1] ?? 'Artifact')
    .slice(0, 1000)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return {
    html,
    title,
    digest: createHash('sha256')
      .update(JSON.stringify([title, html]))
      .digest('hex'),
  };
}
export function publicationStatus(path: string, settings: RemoteSettings): RemoteStatus {
  if (!settings.remote)
    return { enabled: false, state: 'disabled', ...(settings.remoteError ? { error: settings.remoteError } : {}) };
  try {
    const m = readMapping(mappingPath(path));
    if (!m) return { enabled: true, state: 'unpublished' };
    if (m.origin !== settings.remote.url) return { enabled: true, state: 'unpublished', warning: errors.changed };
    const synced = m.isPublic && m.state === 'synced' && !m.operation && snapshot(path).digest === m.digest;
    return {
      enabled: true,
      state: synced ? 'synced' : 'unsynced',
      isPublic: m.isPublic,
      ...(m.slug
        ? { viewerUrl: `${m.origin}/${m.slug}/`, ...(m.isPublic ? { url: `${m.origin}/${m.slug}/` } : {}) }
        : {}),
      ...(m.error ? { error: errors[m.error] } : {}),
    };
  } catch {
    return { enabled: true, state: 'unsynced', error: errors.mapping };
  }
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 16384) throw new Error();
      chunks.push(r.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
class TransportError extends Error {
  constructor(public code: ErrorCode) {
    super(errors[code]);
  }
}
async function request(config: RemoteConfig, path: string, init: RequestInit = {}) {
  const token = process.env[config.tokenEnv];
  if (!token || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new TransportError('credentials');
  try {
    const response = await fetch(config.url + path, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TransportError(
        response.status === 401 || response.status === 403
          ? 'denied'
          : response.status === 409 || response.status === 412
            ? 'conflict'
            : 'network',
      );
    }
    return await responseJson(response);
  } catch (e) {
    if (e instanceof TransportError) throw e;
    throw new TransportError('network');
  }
}
/** Serializes in-process and cross-process writers. An interrupted operation always replays its saved bytes/key. */
export function publishArtifact(path: string, settings: RemoteSettings, explicit = true): Promise<RemoteStatus> {
  path = resolve(path);
  const previous = queues.get(path) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      const lock = mappingPath(path) + '.lock';
      try {
        mkdirSync(lock, { mode: 0o700 });
      } catch {
        return { enabled: !!settings.remote, state: 'unsynced' as const, error: errors.busy };
      }
      try {
        return await upload(path, settings, explicit);
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    })
    .catch((): RemoteStatus => ({ enabled: !!settings.remote, state: 'unsynced', error: errors.storage }));
  queues.set(path, task);
  void task
    .finally(() => {
      if (queues.get(path) === task) queues.delete(path);
    })
    .catch(() => {});
  return task;
}
async function upload(path: string, settings: RemoteSettings, explicit: boolean): Promise<RemoteStatus> {
  const config = settings.remote;
  if (!config) return publicationStatus(path, settings);
  const file = mappingPath(path);
  let m: Mapping | null;
  try {
    m = readMapping(file);
  } catch {
    return { enabled: true, state: 'unsynced', error: errors.mapping };
  }
  if (!explicit && (!config.autoSync || !m?.published || m.origin !== config.url || m.error === 'conflict'))
    return publicationStatus(path, settings);
  const changed = !!m && m.origin !== config.url;
  if (!m || changed) {
    if (m) save(file + '.backup-' + randomBytes(8).toString('hex'), m, true);
    const fresh: Mapping = {
      version: 2,
      origin: config.url,
      revision: 0,
      digest: '',
      isPublic: false,
      published: false,
      state: 'unsynced',
    };
    save(file, fresh, !m);
    m = fresh;
  }
  const current = m;
  try {
    // A conflict is known not to have committed. Only an explicit retry rebases it.
    if (current.error === 'conflict' && explicit && current.slug) {
      const metadata = await request(config, `/api/links/${current.slug}`);
      if (!Number.isSafeInteger(metadata.current_version) || typeof metadata.is_public !== 'boolean')
        throw new TransportError('network');
      current.revision = metadata.current_version as number;
      current.isPublic = metadata.is_public;
      delete current.operation;
      delete current.error;
      save(file, current);
    }
    // Resolve any lost response before reading newer local content. At most one follow-up replacement.
    for (let step = 0; step < 2; step++) {
      const content = snapshot(path);
      if (!current.operation && current.slug && content.digest === current.digest) break;
      if (!current.operation) {
        const operation = {
          key: randomBytes(16).toString('hex'),
          digest: content.digest,
          title: content.title,
          revision: current.revision,
        };
        writeFileSync(file + '.pending-' + operation.key, content.html, { mode: 0o600, flag: 'wx', flush: true });
        current.operation = operation;
        current.state = 'unsynced';
        delete current.error;
        save(file, current);
      }
      const op = current.operation;
      const html = readFileSync(file + '.pending-' + op.key, 'utf8');
      if (
        createHash('sha256')
          .update(JSON.stringify([op.title, html]))
          .digest('hex') !== op.digest
      )
        throw new TransportError('storage');
      const form = new FormData();
      form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
      form.append('paths', JSON.stringify(['index.html']));
      form.append('title', op.title);
      const value = await request(config, current.slug ? `/api/links/${current.slug}/file` : '/api/upload', {
        method: 'POST',
        headers: { 'If-Match': `"${op.revision}"`, 'Idempotency-Key': op.key },
        body: form,
      });
      if (
        typeof value.slug !== 'string' ||
        !/^[a-z0-9]{8,16}$/.test(value.slug) ||
        (current.slug && value.slug !== current.slug) ||
        value.url !== `${config.url}/${value.slug}/` ||
        !Number.isSafeInteger(value.current_version) ||
        (value.current_version as number) < 1 ||
        typeof value.is_public !== 'boolean'
      )
        throw new TransportError('network');
      current.slug = value.slug;
      current.revision = value.current_version as number;
      current.digest = op.digest;
      current.isPublic = value.is_public;
      delete current.operation;
      delete current.error;
      save(file, current);
      rmSync(file + '.pending-' + op.key, { force: true });
    }
    const metadata = await request(config, `/api/links/${current.slug}`);
    if (typeof metadata.is_public !== 'boolean' || !Number.isSafeInteger(metadata.current_version))
      throw new TransportError('network');
    current.isPublic = metadata.is_public;
    if (metadata.current_version !== current.revision) throw new TransportError('conflict');
    save(file, current);
    if (explicit) {
      const visibility = await request(config, `/api/links/${current.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${current.revision}"` },
        body: JSON.stringify({ is_public: true }),
      });
      if (visibility.is_public !== true) throw new TransportError('network');
      current.isPublic = true;
      current.published = true;
    }
    if (!current.isPublic) throw new TransportError('private');
    current.state = 'synced';
    delete current.error;
    save(file, current);
    return { ...publicationStatus(path, settings), ...(changed ? { warning: errors.changed } : {}) };
  } catch (e) {
    const failure = e instanceof TransportError ? e.code : 'storage';
    // Re-read durable state: a failed save must not discard the replayable operation.
    try {
      const durable = readMapping(file);
      if (durable) save(file, { ...durable, state: 'unsynced', error: failure });
    } catch {}
    return { ...publicationStatus(path, settings), state: 'unsynced', error: errors[failure] };
  }
}
/** Explicit control only. Tickets are never saved in publication metadata. */
export async function viewingSignIn(path: string, settings: RemoteSettings): Promise<{ url: string }> {
  const config = settings.remote;
  const m = readMapping(mappingPath(path));
  if (!config || !m?.slug || m.origin !== config.url)
    throw new Error('Publish this artifact to the configured host first.');
  const value = await request(config, '/api/owner/viewing-tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ return_path: `/${m.slug}/` }),
  });
  if (
    typeof value.url !== 'string' ||
    !value.url.startsWith(config.url + '/owner/sign-in?ticket=') ||
    !/^[a-f0-9]{64}$/.test(value.url.split('ticket=')[1] ?? '')
  )
    throw new Error(errors.network);
  return { url: value.url };
}
