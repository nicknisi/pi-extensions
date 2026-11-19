/**
 * Auth core for Anthropic's Claude Design MCP server.
 *
 * Anthropic does not support generic OAuth clients for this server (no
 * metadata discovery, no dynamic client registration). This runs the same
 * PKCE flow as Claude Code's /design-login, using Anthropic's pre-registered
 * Design OAuth client id. Tokens are stored locally and only ever sent to
 * Anthropic hosts. Anthropic may change or revoke this flow.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Anthropic's Design OAuth client (same as Claude Code /design-login)
const CLIENT_ID = '59637612-477b-4836-a601-b0589eda7704';
const SCOPES = 'user:design:read user:design:write';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const REFRESH_SKEW_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
// A lock is stale once its owner pid is gone. Unowned/unreadable locks (crash mid-write)
// expire after a short grace; owned locks also expire after a long max age (pid reuse).
const LOCK_UNOWNED_STALE_MS = 30_000;
const LOCK_MAX_AGE_MS = 5 * 60_000;
const LOCK_POLL_MS = 100;

export const STORE_PATH =
  process.env['PI_CLAUDE_DESIGN_CREDENTIALS'] ?? join(homedir(), '.config', 'pi-claude-design', 'credentials.json');

interface TokenStore {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface LoginStart {
  url: string;
  state: string;
  verifier: string;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

function isTokenStore(value: unknown): value is TokenStore {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['accessToken'] === 'string' &&
    typeof v['refreshToken'] === 'string' &&
    typeof v['expiresAt'] === 'number' &&
    Number.isFinite(v['expiresAt'])
  );
}

async function loadStore(): Promise<TokenStore | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(STORE_PATH, 'utf8'));
    return isTokenStore(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic write: a fresh 0600 temp file renamed over the store, so readers never see partial JSON. */
async function saveStore(store: TokenStore): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.${b64url(randomBytes(6))}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(tmp, STORE_PATH);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errCode(error) !== 'ESRCH';
  }
}

/** Whether the lock at `path` is stale (owner pid gone); null if there is no lock. */
async function lockIsStale(path: string): Promise<boolean | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    [raw, { mtimeMs }] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  } catch (error) {
    if (errCode(error) === 'ENOENT') return null;
    throw error;
  }
  const age = Date.now() - mtimeMs;
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    // Unowned: written by an older version or a crash mid-write.
  }
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) return age > LOCK_MAX_AGE_MS || !pidAlive(pid);
  return age > LOCK_UNOWNED_STALE_MS;
}

/** O_EXCL create; false if the file already exists. */
async function tryCreate(path: string, body: string): Promise<boolean> {
  try {
    await writeFile(path, body, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (errCode(error) === 'EEXIST') return false;
    throw error;
  }
}

async function releaseIfOwned(path: string, body: string): Promise<void> {
  const held = await readFile(path, 'utf8').catch(() => null);
  if (held === body) await rm(path, { force: true });
}

/**
 * Remove a stale lock. Breakers serialize on a short-lived guard file and re-check
 * staleness while holding it, so two waiters that saw the same abandoned lock can't
 * delete each other's fresh lock.
 */
async function breakStaleLock(lockPath: string, body: string): Promise<void> {
  const guard = `${lockPath}.break`;
  if (!(await tryCreate(guard, body))) {
    // Guard is only held for a few fs ops; clear it if its holder died.
    if (await lockIsStale(guard)) await rm(guard, { force: true });
    else await sleep(LOCK_POLL_MS);
    return;
  }
  try {
    if (await lockIsStale(lockPath)) await rm(lockPath, { force: true });
  } finally {
    await releaseIfOwned(guard, body);
  }
}

/** Serialize refreshes across processes with an O_EXCL lockfile owned by pid + random token. */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${STORE_PATH}.lock`;
  const body = JSON.stringify({ pid: process.pid, token: b64url(randomBytes(12)) });
  await mkdir(dirname(STORE_PATH), { recursive: true });
  while (!(await tryCreate(lockPath, body))) {
    const stale = await lockIsStale(lockPath);
    if (stale) await breakStaleLock(lockPath, body);
    else if (stale === false) await sleep(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await releaseIfOwned(lockPath, body);
  }
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as TokenResponse;
}

export function toStore(data: TokenResponse, previous?: TokenStore): TokenStore {
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new Error('Token response missing refresh_token');
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
}

export function parsePastedCode(raw: string): { code: string; state: string } | null {
  const parts = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .split('#');
  const [code, state] = parts;
  if (parts.length !== 2 || !code || !state) return null;
  return { code, state };
}

/** Build the browser authorization URL plus the PKCE secrets needed to finish. */
export function startLogin(): LoginStart {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(32));
  const url = new URL(AUTHORIZE_URL);
  url.search = String(
    new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }),
  );
  return { url: String(url), state, verifier };
}

/** Exchange the pasted CODE#STATE value for tokens and persist them. */
export async function completeLogin(start: LoginStart, rawPaste: string): Promise<void> {
  const pasted = parsePastedCode(rawPaste);
  if (!pasted) throw new Error('Expected a value like CODE#STATE');
  if (pasted.state !== start.state) throw new Error('State mismatch — paste the code from this login attempt');

  const data = await postToken({
    grant_type: 'authorization_code',
    code: pasted.code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: start.verifier,
    state: pasted.state,
  });
  const granted = data.scope ?? SCOPES;
  for (const scope of SCOPES.split(' ')) {
    if (!granted.includes(scope)) throw new Error(`Design scope not granted: ${scope}`);
  }
  await saveStore(toStore(data));
}

/** Return a valid access token, refreshing first when expired or near expiry. */
export async function freshAccessToken(): Promise<string> {
  const notLoggedIn = () => new Error('Not logged in. Run /design-login in pi or: claude-design-auth login');
  const needsRefresh = (s: TokenStore) => Date.now() >= s.expiresAt - REFRESH_SKEW_MS;
  const store = await loadStore();
  if (!store?.accessToken || !store.refreshToken) throw notLoggedIn();
  if (!needsRefresh(store)) return store.accessToken;
  return withRefreshLock(async () => {
    // Another process may have refreshed while we waited for the lock.
    let current = await loadStore();
    if (!current?.accessToken || !current.refreshToken) throw notLoggedIn();
    if (needsRefresh(current)) {
      const data = await postToken({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPES,
      });
      current = toStore(data, current);
      await saveStore(current);
    }
    return current.accessToken;
  });
}

export async function statusText(): Promise<string> {
  const store = await loadStore();
  if (!store) return `logged_out (${STORE_PATH})`;
  const state = Date.now() >= store.expiresAt ? 'expired (will auto-refresh)' : 'logged_in';
  return `${state}, expires ${new Date(store.expiresAt).toISOString()} (${STORE_PATH})`;
}

export async function logout(): Promise<void> {
  await rm(STORE_PATH, { force: true });
}
