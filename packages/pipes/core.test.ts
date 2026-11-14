import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_API_KEY_COMMAND,
  PipesClient,
  authorizationRequired,
  isWrite,
  loadConfig,
  relayUrl,
  resolveApiKey,
  type PipesConfig,
} from './core.js';

const config: PipesConfig = {
  userId: 'user_1',
  apiKeyCommand: DEFAULT_API_KEY_COMMAND,
  baseUrl: 'https://api.example.test',
  maxInlineChars: 100,
  connectTimeoutMs: 1000,
};

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 500, body: 'no more responses' };
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: { 'content-type': 'application/json' } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('relayUrl', () => {
  it('uses path routing under /relay/<provider>', () => {
    expect(relayUrl('https://api.workos.com', 'google-sheets', '/v4/spreadsheets/abc?fields=x')).toBe(
      'https://api.workos.com/relay/google-sheets/v4/spreadsheets/abc?fields=x',
    );
  });

  it('rejects paths without a leading slash and malformed provider slugs', () => {
    expect(() => relayUrl('https://x', 'github', 'user')).toThrow(/start with/);
    expect(() => relayUrl('https://x', '../github', '/user')).toThrow(/Invalid provider/);
  });

  it.each([
    '/../../user_management/users',
    '/%2e%2e/%2E%2E/user_management/users',
    '/v4/./../../organizations',
    '/..%2f..%2fuser_management',
    '/..\\..\\user_management',
    '/%zz',
  ])('refuses paths that could leave the relay prefix: %s', (path) => {
    expect(() => relayUrl('https://api.workos.com', 'google-sheets', path)).toThrow();
  });

  it('keeps dots inside ordinary segments and query strings', () => {
    expect(relayUrl('https://api.workos.com', 'github', '/repos/a/b.c/contents/x..y?ref=v1.2')).toBe(
      'https://api.workos.com/relay/github/repos/a/b.c/contents/x..y?ref=v1.2',
    );
  });
});

describe('isWrite', () => {
  it('treats only GET and HEAD as reads', () => {
    expect(isWrite('GET')).toBe(false);
    expect(isWrite('HEAD')).toBe(false);
    expect(isWrite('POST')).toBe(true);
    expect(isWrite('DELETE')).toBe(true);
  });
});

describe('loadConfig', () => {
  it('reads the config file and lets WORKOS_PIPES_* override it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipes-'));
    try {
      const file = join(dir, 'pipes.json');
      writeFileSync(
        file,
        JSON.stringify({ userId: 'user_file', baseUrl: 'https://api.workos.com/', maxInlineChars: 5 }),
      );
      const fromFile = loadConfig(file, {});
      expect(fromFile).toMatchObject({ userId: 'user_file', baseUrl: 'https://api.workos.com', maxInlineChars: 5 });
      expect(fromFile.apiKeyCommand).toBe(DEFAULT_API_KEY_COMMAND);
      expect(loadConfig(file, { WORKOS_PIPES_USER: 'user_env' }).userId).toBe('user_env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explains how to configure a user when none is set', () => {
    expect(() => loadConfig('/nonexistent/pipes.json', {})).toThrow(/WORKOS_PIPES_USER/);
  });

  it('refuses a non-https base URL, since the API key is sent to it', () => {
    const env = { WORKOS_PIPES_USER: 'user_1', WORKOS_PIPES_BASE_URL: 'http://api.workos.com' };
    expect(() => loadConfig('/nonexistent/pipes.json', env)).toThrow(/https/);
  });
});

describe('resolveApiKey', () => {
  it('prefers WORKOS_PIPES_API_KEY over the key command', async () => {
    const run = vi.fn(async () => 'from-command');
    await expect(resolveApiKey(config, { WORKOS_PIPES_API_KEY: 'from-env' }, run)).resolves.toBe('from-env');
    expect(run).not.toHaveBeenCalled();
    await expect(resolveApiKey(config, {}, run)).resolves.toBe('from-command');
  });

  it('says how to store the key when the command fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('item not found');
    });
    await expect(resolveApiKey(config, {}, run)).rejects.toThrow(/add-generic-password/);
  });
});

describe('PipesClient.relay', () => {
  it('sends the API key and relay user, and a JSON body only for writes', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { ok: true } },
      { status: 201, body: { created: true } },
    ]);
    const client = new PipesClient({ ...config, organizationId: 'org_1' }, 'sk_test', impl);
    await client.relay({ provider: 'github', path: '/user', body: { ignored: true } });
    await client.relay({ provider: 'github', path: '/user/repos', method: 'POST', body: { name: 'x' } });

    const [read, write] = calls;
    expect(read!.url).toBe('https://api.example.test/relay/github/user');
    expect(read!.init.headers).toMatchObject({
      Authorization: 'Bearer sk_test',
      'X-Relay-User': 'user_1',
      'X-Relay-Organization': 'org_1',
    });
    expect(read!.init.body).toBeUndefined();
    expect(write!.init.method).toBe('POST');
    expect(write!.init.body).toBe('{"name":"x"}');
  });
});

describe('authorizationRequired', () => {
  it('extracts the sign-in link from a relay 402', () => {
    const body = JSON.stringify({ code: 'relay_authorization_required', authorization_url: 'https://auth' });
    expect(authorizationRequired({ status: 402, contentType: '', body })).toBe('https://auth');
  });

  it('returns null for a 402 without a link and undefined for anything else', () => {
    const noLink = JSON.stringify({ code: 'relay_authorization_required', authorization_url: null });
    expect(authorizationRequired({ status: 402, contentType: '', body: noLink })).toBeNull();
    expect(authorizationRequired({ status: 404, contentType: '', body: noLink })).toBeUndefined();
    expect(authorizationRequired({ status: 402, contentType: '', body: 'not json' })).toBeUndefined();
  });
});

describe('PipesClient connections', () => {
  it('returns null for a missing connection', async () => {
    const { impl, calls } = fakeFetch([{ status: 404, body: { code: 'entity_not_found' } }]);
    const client = new PipesClient(config, 'sk_test', impl);
    await expect(client.connection('google-sheets')).resolves.toBeNull();
    expect(calls[0]!.url).toBe(
      'https://api.example.test/user_management/users/user_1/connected_accounts/google-sheets',
    );
  });

  it('waits until the connection reports connected', async () => {
    const { impl } = fakeFetch([
      { status: 404, body: {} },
      { status: 200, body: { state: 'needs_reauthorization' } },
      { status: 200, body: { state: 'connected', scopes: ['a'] } },
    ]);
    const client = new PipesClient(config, 'sk_test', impl);
    await expect(client.waitForConnection('google-sheets', { timeoutMs: 1000, intervalMs: 1 })).resolves.toBe(true);
  });

  it('gives up at the timeout', async () => {
    const { impl } = fakeFetch(Array.from({ length: 50 }, () => ({ status: 404, body: {} })));
    const client = new PipesClient(config, 'sk_test', impl);
    await expect(client.waitForConnection('google-sheets', { timeoutMs: 20, intervalMs: 5 })).resolves.toBe(false);
  });

  it('asks for an authorization link with the configured user and explains a missing provider', async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, body: { url: 'https://api.workos.com/data-integrations/x/authorize-redirect' } },
      { status: 404, body: { code: 'entity_not_found' } },
    ]);
    const client = new PipesClient(config, 'sk_test', impl);
    await expect(client.authorizeUrl('google-sheets')).resolves.toContain('authorize-redirect');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ user_id: 'user_1' });
    await expect(client.authorizeUrl('google-drive')).rejects.toThrow(/not set up for users/);
  });
});
