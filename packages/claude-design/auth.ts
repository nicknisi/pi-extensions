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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Anthropic's Design OAuth client (same as Claude Code /design-login)
const CLIENT_ID = '59637612-477b-4836-a601-b0589eda7704';
const SCOPES = 'user:design:read user:design:write';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const REFRESH_SKEW_MS = 60_000;

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

async function loadStore(): Promise<TokenStore | null> {
  try {
    return JSON.parse(await readFile(STORE_PATH, 'utf8')) as TokenStore;
  } catch {
    return null;
  }
}

async function saveStore(store: TokenStore): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as TokenResponse;
}

function toStore(data: TokenResponse, previous?: TokenStore): TokenStore {
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
  let store = await loadStore();
  if (!store?.accessToken || !store.refreshToken) {
    throw new Error('Not logged in. Run /design-login in pi or: claude-design-auth login');
  }
  if (Date.now() >= store.expiresAt - REFRESH_SKEW_MS) {
    const data = await postToken({
      grant_type: 'refresh_token',
      refresh_token: store.refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES,
    });
    store = toStore(data, store);
    await saveStore(store);
  }
  return store.accessToken;
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
