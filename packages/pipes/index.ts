import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import {
  PipesClient,
  authorizationRequired,
  configPath,
  isWorkOSUrl,
  isWrite,
  loadConfig,
  resolveApiKey,
  type HttpMethod,
  type HttpResult,
  type PipesConfig,
} from './core.js';

const PREVIEW_CHARS = 2000;

export interface PipesDeps {
  loadConfig: () => PipesConfig;
  resolveApiKey: (config: PipesConfig) => Promise<string>;
  fetch: typeof fetch;
  openUrl: (url: string, config: PipesConfig) => void;
  /** Where oversized responses are written. */
  outputDir: string;
}

/** Open an https sign-in link. The URL comes from WorkOS, so it is passed as an argument, never spliced into a shell string. */
export function openUrl(url: string, config: PipesConfig): void {
  if (!url.startsWith('https://')) throw new Error(`Refusing to open a non-https URL: ${url}`);
  const child = config.openCommand
    ? spawn('/bin/sh', ['-c', `${config.openCommand} "$1"`, 'sh', url], { detached: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

const defaultDeps: PipesDeps = {
  loadConfig: () => loadConfig(),
  resolveApiKey: (config) => resolveApiKey(config),
  fetch: (input, init) => fetch(input, init),
  openUrl,
  outputDir: join(tmpdir(), 'pi-pipes'),
};

const parameters = Type.Object({
  provider: Type.String({
    description: 'Pipes provider slug, e.g. google-sheets, google-drive, github, slack, linear, notion.',
    pattern: '^[a-z0-9][a-z0-9-]*$',
  }),
  path: Type.String({
    description:
      "API path on the provider's default host, starting with '/', including any query string. URL-encode path segments (space → %20).",
    pattern: '^/',
  }),
  method: Type.Optional(
    Type.Union(
      [
        Type.Literal('GET'),
        Type.Literal('HEAD'),
        Type.Literal('POST'),
        Type.Literal('PUT'),
        Type.Literal('PATCH'),
        Type.Literal('DELETE'),
      ],
      { description: 'Defaults to GET. Any other method asks the user to approve the request first.' },
    ),
  ),
  body: Type.Optional(Type.Unknown({ description: 'JSON request body for POST, PUT or PATCH.' })),
});

type PipesParams = Static<typeof parameters>;

export interface PipesDetails {
  provider: string;
  path: string;
  method: HttpMethod;
  status?: number | undefined;
  savedTo?: string | undefined;
}

function textResult(text: string, details: PipesDetails) {
  return { content: [{ type: 'text' as const, text }], details };
}

function errorResult(text: string, details: PipesDetails) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true, details };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeRequest(params: PipesParams, method: HttpMethod): string {
  const lines = [`${method} ${params.provider}${params.path}`];
  if (params.body !== undefined) {
    const body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body, null, 2);
    lines.push('', body.length > 1500 ? `${body.slice(0, 1500)}…` : body);
  }
  return lines.join('\n');
}

function relayHint(body: string): string {
  if (body.includes('relay_provider_not_found')) {
    return '\nThis provider is not enabled for Relay in this WorkOS environment, or the path belongs to a different provider (Google Drive endpoints use google-drive, not google-sheets).';
  }
  return '';
}

export function formatResponse(
  result: HttpResult,
  details: PipesDetails,
  config: Pick<PipesConfig, 'maxInlineChars'>,
  outputDir: string,
) {
  details.status = result.status;
  if (result.status >= 400) {
    return errorResult(
      `HTTP ${result.status} from ${details.provider}: ${result.body.slice(0, PREVIEW_CHARS)}${relayHint(result.body)}`,
      details,
    );
  }
  let text = result.body;
  let isJson = false;
  try {
    text = JSON.stringify(JSON.parse(result.body), null, 2);
    isJson = true;
  } catch {
    // Not JSON: return the body as-is.
  }
  if (text.length <= config.maxInlineChars) return textResult(text || `HTTP ${result.status} (empty body)`, details);
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, `${Date.now()}-${details.provider}.${isJson ? 'json' : 'txt'}`);
  writeFileSync(file, text);
  details.savedTo = file;
  return textResult(
    `${text.slice(0, PREVIEW_CHARS)}\n…\n\nFull response (${text.length} characters) saved to ${file}. Read or query that file for the rest.`,
    details,
  );
}

export function createPipesExtension(deps: PipesDeps = defaultDeps) {
  let cached: Promise<{ client: PipesClient; config: PipesConfig }> | undefined;
  const getClient = () => {
    cached ??= (async () => {
      const config = deps.loadConfig();
      const apiKey = await deps.resolveApiKey(config);
      return { client: new PipesClient(config, apiKey, deps.fetch), config };
    })();
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };

  /** Send the user to `url`, then wait for `provider` to show as connected. */
  async function signIn(
    client: PipesClient,
    config: PipesConfig,
    provider: string,
    url: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Relay passes provider responses through, so a provider's own 402 could carry a look-alike link.
    if (!isWorkOSUrl(url, config.baseUrl)) {
      throw new Error(`Refusing to open a sign-in link outside ${config.baseUrl}: ${url}`);
    }
    deps.openUrl(url, config);
    ctx.ui.notify(`Approve ${provider} in your browser. If it didn't open: ${url}`, 'info');
    ctx.ui.setStatus('pipes', `waiting for ${provider} sign-in…`);
    try {
      return await client.waitForConnection(provider, { timeoutMs: config.connectTimeoutMs, signal });
    } finally {
      ctx.ui.setStatus('pipes', undefined);
    }
  }

  return function pipesExtension(pi: ExtensionAPI) {
    pi.registerTool({
      name: 'pipes',
      label: 'Pipes',
      description:
        "Call a third-party API as the user through WorkOS Pipes Relay. The request goes to <WorkOS>/relay/<provider><path>, which forwards it to the provider's default API host with the user's stored OAuth token (provider google-sheets + path /v4/spreadsheets/<id> reaches sheets.googleapis.com). GET runs directly; other methods ask the user to approve first. When the provider isn't connected yet, the user is sent to sign in and the call retries once they approve. Responses over the size limit are saved to a file and a preview plus the file path is returned.",
      promptSnippet:
        "Read or act on the user's own third-party accounts (Google Sheets, Google Drive, GitHub, Slack, Linear…) through WorkOS Pipes.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      parameters,
      async execute(_id: string, params: PipesParams, signal: AbortSignal | undefined, _onUpdate, ctx) {
        const method: HttpMethod = params.method ?? 'GET';
        const details: PipesDetails = { provider: params.provider, path: params.path, method };
        try {
          const { client, config } = await getClient();
          if (isWrite(method)) {
            if (!ctx.hasUI) {
              return errorResult(`${method} needs the user's approval, and this session has no UI to ask.`, details);
            }
            const approved = await ctx.ui.confirm(
              `Pipes: ${method} ${params.provider}`,
              describeRequest(params, method),
            );
            if (!approved) return errorResult('The user declined this request.', details);
          }
          const request = { provider: params.provider, path: params.path, method, body: params.body };
          let result = await client.relay(request, signal);
          const signInUrl = authorizationRequired(result);
          if (signInUrl !== undefined) {
            if (signInUrl === null) {
              return errorResult(
                `${params.provider} has no connected credentials, and it isn't an OAuth provider, so it must be set up in the WorkOS dashboard.`,
                details,
              );
            }
            if (!ctx.hasUI) {
              return errorResult(
                `${params.provider} isn't connected. Ask the user to open ${signInUrl}, approve, then retry.`,
                details,
              );
            }
            const connected = await signIn(client, config, params.provider, signInUrl, ctx, signal);
            if (!connected) {
              return errorResult(
                `${params.provider} still isn't connected. The sign-in link was ${signInUrl}`,
                details,
              );
            }
            result = await client.relay(request, signal);
          }
          return formatResponse(result, details, config, deps.outputDir);
        } catch (error) {
          return errorResult(message(error), details);
        }
      },
    });

    pi.registerCommand('pipes', {
      description: 'WorkOS Pipes: /pipes status [provider] | /pipes connect <provider>',
      getArgumentCompletions: (prefix: string) =>
        ['status', 'connect'].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
      handler: async (args, ctx) => {
        const [sub = 'status', provider] = args.trim().split(/\s+/).filter(Boolean);
        try {
          if (sub === 'status' && !provider) {
            const { config } = await getClient();
            const key = process.env.WORKOS_PIPES_API_KEY ? 'WORKOS_PIPES_API_KEY' : `\`${config.apiKeyCommand}\``;
            ctx.ui.notify(
              [
                `config: ${configPath()}`,
                `user: ${config.userId}${config.organizationId ? ` (org ${config.organizationId})` : ''}`,
                `API key: read from ${key}`,
                `endpoint: ${config.baseUrl}`,
              ].join('\n'),
              'info',
            );
            return;
          }
          if (!provider || !['status', 'connect'].includes(sub)) {
            ctx.ui.notify('Usage: /pipes status [provider] | /pipes connect <provider>', 'warning');
            return;
          }
          const { client, config } = await getClient();
          if (sub === 'status') {
            const connection = await client.connection(provider);
            ctx.ui.notify(
              connection
                ? `${provider}: ${connection.state}\nscopes: ${connection.scopes.join(', ') || 'none'}${connection.missingScopes.length ? `\nmissing: ${connection.missingScopes.join(', ')}` : ''}`
                : `${provider}: not connected. Run /pipes connect ${provider}`,
              connection?.state === 'connected' ? 'info' : 'warning',
            );
            return;
          }
          const url = await client.authorizeUrl(provider);
          const connected = await signIn(client, config, provider, url, ctx);
          ctx.ui.notify(
            connected
              ? `${provider} connected`
              : `${provider} wasn't connected in time. Run /pipes connect ${provider} to retry.`,
            connected ? 'info' : 'warning',
          );
        } catch (error) {
          ctx.ui.notify(message(error), 'error');
        }
      },
    });
  };
}

export default createPipesExtension();
