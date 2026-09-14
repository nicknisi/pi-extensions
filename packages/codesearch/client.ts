// Adapted from dot-pi at 73fe0529c38f9a66fbf9a1b71c88d0d4980afceb. See THIRD_PARTY_NOTICES.md.
import { truncateHead, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT = 30_000;

export async function fetchText(url: string, init: RequestInit, signal?: AbortSignal, timeout = TIMEOUT) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) throw new Error('Missing HTTP response body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new Error(`Response exceeds ${MAX_BODY_BYTES} byte limit`);
        chunks.push(value);
      }
      controller.signal.throwIfAborted();
      return { text: Buffer.concat(chunks).toString('utf8'), contentType: response.headers.get('content-type') ?? '' };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Skip SSE notifications, but never swallow malformed JSON or error responses. */
export function parseRpc(body: string): Record<string, unknown> {
  const payloads = body.trimStart().startsWith('{')
    ? [body]
    : body
        .replace(/\r\n?/g, '\n')
        .split('\n\n')
        .map((event) =>
          event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n'),
        );
  for (const payload of payloads) {
    if (!payload.trim() || payload.trim() === '[DONE]') continue;
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      throw new Error('Invalid JSON in search response');
    }
    if (!object(data)) throw new Error('Invalid JSON-RPC response');
    if ('error' in data) {
      const message = object(data.error) ? data.error.message : undefined;
      throw new Error(`JSON-RPC error: ${typeof message === 'string' ? message.slice(0, 500) : 'unknown error'}`);
    }
    if ('result' in data && data.id === 1) return data;
  }
  throw new Error('Search response contains no JSON-RPC result');
}

export interface SearchParams {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWords?: boolean;
  repo?: string;
  path?: string;
  lang?: string[];
}

export async function search(params: SearchParams, signal?: AbortSignal): Promise<string> {
  if (!params.query.trim()) throw new Error('query must not be empty');
  const { text: body } = await fetchText(
    'https://mcp.grep.app/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'searchGitHub',
          arguments: {
            query: params.query,
            useRegexp: params.regex ?? false,
            matchCase: params.caseSensitive ?? false,
            matchWholeWords: params.wholeWords ?? false,
            ...(params.repo ? { repo: params.repo } : {}),
            ...(params.path ? { path: params.path } : {}),
            ...(params.lang ? { language: params.lang } : {}),
          },
        },
      }),
    },
    signal,
  );
  const result = parseRpc(body).result;
  if (!object(result) || !Array.isArray(result.content)) throw new Error('Malformed search result');
  const texts: string[] = [];
  for (const item of result.content) {
    if (!object(item) || item.type !== 'text' || typeof item.text !== 'string')
      throw new Error('Unsupported search content');
    texts.push(item.text);
  }
  const text = texts.join('\n\n').trim();
  if (result.isError === true) throw new Error(`Search service error: ${text.slice(0, 500) || 'unknown error'}`);
  if (!text || /^No (results|matches)( found)?( for your query)?[.!]?$/i.test(text)) return 'No results found.';
  // Keep upstream snippets and their source URLs intact, rather than discarding unfamiliar code formatting.
  if (
    !/^Repository:\s*\S/m.test(text) ||
    !/^Path:\s*\S/m.test(text) ||
    !/^URL:\s*https:\/\/github\.com\//m.test(text)
  ) {
    throw new Error('Unrecognized search result format');
  }
  return text;
}

export interface FetchParams {
  url?: string;
  repo?: string;
  path?: string;
  ref?: string;
  startLine?: number;
  endLine?: number;
}

export function resolveTarget(params: FetchParams) {
  let { repo, path, ref } = params;
  if (params.url !== undefined) {
    if (repo !== undefined || path !== undefined || ref !== undefined)
      throw new Error('Use url OR repo/path/ref, not both');
    const url = new URL(params.url);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search)
      throw new Error('Expected an HTTPS github.com blob URL');
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
    if (parts[2] !== 'blob' || parts.length < 5) throw new Error('Expected a GitHub blob URL');
    repo = `${parts[0]}/${parts[1]}`;
    ref = parts[3];
    path = parts.slice(4).join('/');
  }
  if (
    !repo ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('repo must be owner/name');
  if (!path || /[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error('path must be a relative file path without dot segments');
  if (ref !== undefined && (!ref || /[\x00-\x20\x7f]/.test(ref))) throw new Error('Invalid ref');
  validateRange(params.startLine, params.endLine);
  return { repo, path, ref };
}

function validateRange(start = 1, end?: number) {
  if (!Number.isSafeInteger(start) || start < 1 || (end !== undefined && (!Number.isSafeInteger(end) || end < start)))
    throw new Error('Line range must use positive 1-based integers with endLine >= startLine');
}

export function sliceLines(text: string, startLine = 1, endLine?: number) {
  validateRange(startLine, endLine);
  const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (startLine > lines.length && !(lines.length === 0 && startLine === 1 && endLine === undefined))
    throw new Error(`startLine ${startLine} exceeds file length (${lines.length} lines)`);
  const end = Math.min(endLine ?? lines.length, lines.length);
  return { text: lines.slice(startLine - 1, end).join('\n'), startLine, endLine: end, totalLines: lines.length };
}

export async function fetchFile(pi: Pick<ExtensionAPI, 'exec'>, params: FetchParams, signal?: AbortSignal) {
  const target = resolveTarget(params);
  signal?.throwIfAborted();
  const endpoint = `repos/${target.repo}/contents/${target.path.split('/').map(encodeURIComponent).join('/')}${target.ref ? `?ref=${encodeURIComponent(target.ref)}` : ''}`;
  let result: Awaited<ReturnType<ExtensionAPI['exec']>> | undefined;
  try {
    result = await pi.exec(
      'gh',
      ['api', '--hostname', 'github.com', endpoint, '--include', '-H', 'Accept: application/vnd.github.raw+json'],
      { ...(signal ? { signal } : {}), timeout: TIMEOUT },
    );
  } catch {
    signal?.throwIfAborted();
    // Missing gh, authentication failures, and command failures use the public API.
  }
  signal?.throwIfAborted();
  let body: { text: string; contentType: string };
  if (result?.code === 0 && !result.killed) {
    const boundary = /\r?\n\r?\n/.exec(result.stdout);
    if (!boundary) throw new Error('Missing GitHub response headers');
    const headers = result.stdout.slice(0, boundary.index);
    body = {
      text: result.stdout.slice(boundary.index + boundary[0].length),
      contentType: /^Content-Type:\s*([^\r\n]+)/im.exec(headers)?.[1] ?? '',
    };
  } else {
    body = await fetchText(
      `https://api.github.com/${endpoint}`,
      { headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'pi-codesearch' } },
      signal,
    );
  }
  signal?.throwIfAborted();
  if (body.contentType.split(';')[0]?.trim().toLowerCase() !== 'application/vnd.github.raw+json')
    throw new Error('GitHub target is not a raw file. Directories are not supported.');
  const { text } = body;
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('GitHub file exceeds body limit');
  if (text.includes('\0')) throw new Error('Binary files are not supported');
  return { ...target, ...sliceLines(text, params.startLine, params.endLine) };
}

export function bounded(text: string, advice: string) {
  // Reserve space for the notice within Pi's 50 KiB / 2000 line output budget.
  const truncation = truncateHead(text, { maxBytes: 50 * 1024 - 512, maxLines: 1998 });
  return {
    content: [
      {
        type: 'text' as const,
        text: truncation.content + (truncation.truncated ? `\n\n[Output truncated. ${advice}]` : ''),
      },
    ],
    details: { truncation },
  };
}
