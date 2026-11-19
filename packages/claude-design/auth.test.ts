import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Auth = typeof import('./auth.js');

let storePath: string;
let auth: Auth;
let fetchMock: ReturnType<typeof vi.fn>;

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function writeStore(store: unknown) {
  writeFileSync(storePath, JSON.stringify(store));
}

const readStore = () => JSON.parse(readFileSync(storePath, 'utf8'));

beforeEach(async () => {
  storePath = join(mkdtempSync(join(tmpdir(), 'claude-design-')), 'credentials.json');
  vi.stubEnv('PI_CLAUDE_DESIGN_CREDENTIALS', storePath);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  auth = await import('./auth.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('completeLogin', () => {
  it('exchanges the code and saves a 0600 store', async () => {
    const start = auth.startLogin();
    fetchMock.mockResolvedValue(
      tokenResponse({
        access_token: 'a1',
        refresh_token: 'r1',
        expires_in: 3600,
        scope: 'user:design:read user:design:write',
      }),
    );
    await auth.completeLogin(start, `code123#${start.state}`);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'code123', code_verifier: start.verifier });
    expect(readStore()).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
  });

  it('rejects a state mismatch without calling the token endpoint', async () => {
    const start = auth.startLogin();
    await expect(auth.completeLogin(start, 'code#other')).rejects.toThrow(/State mismatch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when design scopes are not granted', async () => {
    const start = auth.startLogin();
    fetchMock.mockResolvedValue(tokenResponse({ access_token: 'a', refresh_token: 'r', scope: 'user:design:read' }));
    await expect(auth.completeLogin(start, `c#${start.state}`)).rejects.toThrow(/user:design:write/);
  });

  it('tightens permissions of an existing loose credentials file', async () => {
    writeFileSync(storePath, '{}', { mode: 0o644 });
    const start = auth.startLogin();
    fetchMock.mockResolvedValue(tokenResponse({ access_token: 'a', refresh_token: 'r' }));
    await auth.completeLogin(start, `c#${start.state}`);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
  });
});

describe('freshAccessToken', () => {
  it('returns the stored token without network when still valid', async () => {
    writeStore({ accessToken: 'valid', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 });
    await expect(auth.freshAccessToken()).resolves.toBe('valid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes when expired and keeps the old refresh token if none is returned', async () => {
    writeStore({ accessToken: 'old', refreshToken: 'keep-me', expiresAt: Date.now() - 1 });
    fetchMock.mockResolvedValue(tokenResponse({ access_token: 'new', expires_in: 3600 }));
    await expect(auth.freshAccessToken()).resolves.toBe('new');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'keep-me',
    });
    expect(readStore()).toMatchObject({ accessToken: 'new', refreshToken: 'keep-me' });
  });

  it('refreshes only once for concurrent callers', async () => {
    writeStore({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 1 });
    fetchMock.mockImplementation(async () => tokenResponse({ access_token: 'new', refresh_token: 'r2' }));
    const tokens = await Promise.all([auth.freshAccessToken(), auth.freshAccessToken(), auth.freshAccessToken()]);
    expect(tokens).toEqual(['new', 'new', 'new']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when not logged in', async () => {
    await expect(auth.freshAccessToken()).rejects.toThrow(/Not logged in/);
  });
});

describe('toStore', () => {
  it('prefers the new refresh token and throws when none is available', () => {
    expect(
      auth.toStore({ access_token: 'a', refresh_token: 'new' }, { accessToken: 'x', refreshToken: 'old', expiresAt: 0 })
        .refreshToken,
    ).toBe('new');
    expect(() => auth.toStore({ access_token: 'a' })).toThrow(/refresh_token/);
  });
});

describe('statusText', () => {
  it('reports logged_out for malformed stores instead of throwing', async () => {
    writeStore({});
    await expect(auth.statusText()).resolves.toMatch(/^logged_out/);
  });
});
