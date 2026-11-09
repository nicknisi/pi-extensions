/**
 * Pi-free client for WorkOS Pipes Relay.
 *
 * Relay forwards a request to a third-party provider with the user's stored
 * OAuth token attached server-side, so the caller only ever holds a WorkOS API
 * key. This module uses Relay's path routing
 * (`/relay/<provider><path>` → the provider's default API host): URL routing
 * via `X-Relay-URL` rejects some provider hosts that path routing serves, for
 * example `sheets.googleapis.com` for the `google-sheets` provider.
 */
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.workos.com';
export const DEFAULT_API_KEY_COMMAND = 'security find-generic-password -s workos-pipes -w';
export const DEFAULT_MAX_INLINE_CHARS = 20_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5 * 60_000;

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface PipesConfig {
  /** WorkOS user whose connected accounts Relay acts as. */
  userId: string;
  /** Scopes connections to an organization; sent as X-Relay-Organization. */
  organizationId?: string | undefined;
  /** Shell command that prints the WorkOS API key. Ignored when WORKOS_PIPES_API_KEY is set. */
  apiKeyCommand: string;
  baseUrl: string;
  /** Shell command used to open sign-in links; the URL is appended as the last argument. */
  openCommand?: string | undefined;
  /** Responses longer than this are saved to a file instead of returned inline. */
  maxInlineChars: number;
  /** How long a sign-in waits for the user to approve before giving up. */
  connectTimeoutMs: number;
}

export type Env = Record<string, string | undefined>;

export function agentDir(env: Env = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (dir?.startsWith('~/')) return join(homedir(), dir.slice(2));
  return dir || join(homedir(), '.pi', 'agent');
}

export function configPath(env: Env = process.env): string {
  return join(agentDir(env), 'configs', 'pipes.json');
}

/** Read `configs/pipes.json` and apply WORKOS_PIPES_* overrides. Throws when no user id is configured. */
export function loadConfig(path: string = configPath(), env: Env = process.env): PipesConfig {
  let file: Partial<PipesConfig> = {};
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as Partial<PipesConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const userId = env.WORKOS_PIPES_USER || file.userId;
  if (!userId) {
    throw new Error(`No WorkOS user configured. Set "userId" in ${path} or WORKOS_PIPES_USER.`);
  }
  return {
    userId,
    organizationId: env.WORKOS_PIPES_ORGANIZATION || file.organizationId,
    apiKeyCommand: file.apiKeyCommand || DEFAULT_API_KEY_COMMAND,
    baseUrl: (env.WORKOS_PIPES_BASE_URL || file.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    openCommand: file.openCommand,
    maxInlineChars: file.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS,
    connectTimeoutMs: file.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  };
}

export type RunCommand = (command: string) => Promise<string>;

export const runCommand: RunCommand = (command) =>
  new Promise((resolve, reject) => {
    exec(command, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });

/** The WorkOS API key: WORKOS_PIPES_API_KEY when set, otherwise the output of `apiKeyCommand`. */
export async function resolveApiKey(
  config: Pick<PipesConfig, 'apiKeyCommand'>,
  env: Env = process.env,
  run: RunCommand = runCommand,
): Promise<string> {
  const fromEnv = env.WORKOS_PIPES_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  let key: string;
  try {
    key = await run(config.apiKeyCommand);
  } catch {
    throw new Error(
      `Could not read the WorkOS API key with \`${config.apiKeyCommand}\`. ` +
        'Store it with: security add-generic-password -U -s workos-pipes -a "$USER" -w',
    );
  }
  if (!key) throw new Error(`\`${config.apiKeyCommand}\` printed nothing; expected a WorkOS API key.`);
  return key;
}

export function assertProvider(provider: string): void {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error(`Invalid provider slug "${provider}". Use the Pipes slug, e.g. google-sheets or github.`);
  }
}

export function relayUrl(baseUrl: string, provider: string, path: string): string {
  assertProvider(provider);
  if (!path.startsWith('/')) throw new Error(`Path must start with "/": ${path}`);
  return `${baseUrl}/relay/${provider}${path}`;
}

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function isWrite(method: HttpMethod): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

export interface RelayRequest {
  provider: string;
  path: string;
  method?: HttpMethod | undefined;
  body?: unknown;
}

export interface HttpResult {
  status: number;
  contentType: string;
  body: string;
}

export interface Connection {
  state: string;
  scopes: string[];
  missingScopes: string[];
}

/**
 * The sign-in link from a Relay 402 `relay_authorization_required` response,
 * `null` when the 402 carries none (API-key and client-credentials providers),
 * or `undefined` when the response is not an authorization requirement.
 */
export function authorizationRequired(result: HttpResult): string | null | undefined {
  if (result.status !== 402) return undefined;
  try {
    const parsed = JSON.parse(result.body) as { code?: string; authorization_url?: string | null };
    if (parsed.code !== 'relay_authorization_required') return undefined;
    return parsed.authorization_url ?? null;
  } catch {
    return undefined;
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal | undefined;
}

export class PipesClient {
  readonly #config: PipesConfig;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(config: PipesConfig, apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }

  async relay(request: RelayRequest, signal?: AbortSignal): Promise<HttpResult> {
    const method = request.method ?? 'GET';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'X-Relay-User': this.#config.userId,
    };
    if (this.#config.organizationId) headers['X-Relay-Organization'] = this.#config.organizationId;
    let body: string | undefined;
    if (request.body !== undefined && isWrite(method)) {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      headers['Content-Type'] = 'application/json';
    }
    return this.#send(relayUrl(this.#config.baseUrl, request.provider, request.path), method, headers, body, signal);
  }

  /** The user's connection to `provider`, or null when there is none. */
  async connection(provider: string, signal?: AbortSignal): Promise<Connection | null> {
    assertProvider(provider);
    const result = await this.#api(
      'GET',
      `/user_management/users/${this.#config.userId}/connected_accounts/${provider}`,
      undefined,
      signal,
    );
    if (result.status === 404) return null;
    if (result.status !== 200) throw httpError('Connection lookup', result);
    const parsed = JSON.parse(result.body) as { state?: string; scopes?: string[]; missing_scopes?: string[] | null };
    return {
      state: parsed.state ?? 'unknown',
      scopes: parsed.scopes ?? [],
      missingScopes: parsed.missing_scopes ?? [],
    };
  }

  /** A fresh sign-in link that connects the user's account for `provider`. */
  async authorizeUrl(provider: string, signal?: AbortSignal): Promise<string> {
    assertProvider(provider);
    const body: Record<string, string> = { user_id: this.#config.userId };
    if (this.#config.organizationId) body.organization_id = this.#config.organizationId;
    const result = await this.#api('POST', `/data-integrations/${provider}/authorize`, JSON.stringify(body), signal);
    if (result.status === 404) {
      throw new Error(
        `Provider "${provider}" is not set up for users in this WorkOS environment. Add it under Pipes in the WorkOS dashboard.`,
      );
    }
    if (result.status !== 200 && result.status !== 201) throw httpError('Authorization link', result);
    const url = (JSON.parse(result.body) as { url?: string }).url;
    if (!url) throw new Error('WorkOS returned no authorization URL.');
    return url;
  }

  /** Poll until the user's `provider` connection is `connected`. Resolves false on timeout or abort. */
  async waitForConnection(provider: string, options: WaitOptions): Promise<boolean> {
    const deadline = Date.now() + options.timeoutMs;
    const interval = options.intervalMs ?? 3000;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) return false;
      const connection = await this.connection(provider, options.signal).catch(() => null);
      if (connection?.state === 'connected') return true;
      await sleep(interval, options.signal);
    }
    return false;
  }

  #api(method: HttpMethod, path: string, body: string | undefined, signal?: AbortSignal): Promise<HttpResult> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return this.#send(`${this.#config.baseUrl}${path}`, method, headers, body, signal);
  }

  async #send(
    url: string,
    method: HttpMethod,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<HttpResult> {
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    if (signal) init.signal = signal;
    const response = await this.#fetch(url, init);
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  }
}

function httpError(what: string, result: HttpResult): Error {
  return new Error(`${what} failed (HTTP ${result.status}): ${result.body.slice(0, 500)}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
