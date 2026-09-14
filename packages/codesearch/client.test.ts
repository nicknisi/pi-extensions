import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bounded,
  fetchFile,
  fetchText,
  MAX_BODY_BYTES,
  parseRpc,
  resolveTarget,
  search,
  sliceLines,
} from './client.js';

const match =
  'Repository: facebook/react\nPath: src/index.js\nURL: https://github.com/facebook/react/blob/main/src/index.js\nLicense: MIT\n--- Snippet 1 (Line 1) ---\nconst x = 1;';
const rpc = (text = match, isError = false) => ({
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text }], isError },
});
const rawHeaders = { 'Content-Type': 'application/vnd.github.raw+json; charset=utf-8' };
const gh = (text = 'one\ntwo\nthree\n', contentType = rawHeaders['Content-Type']) => ({
  exec: vi.fn().mockResolvedValue({
    code: 0,
    killed: false,
    stdout: `HTTP/2.0 200 OK\nContent-Type: ${contentType}\r\n\r\n${text}`,
    stderr: '',
  }),
});
afterEach(() => vi.unstubAllGlobals());

describe('search', () => {
  it('parses JSON and SSE, including notification and multiline data', () => {
    expect(parseRpc(JSON.stringify(rpc())).result).toEqual(rpc().result);
    expect(
      parseRpc(
        `: ping\r\ndata: {"jsonrpc":"2.0","method":"progress"}\r\n\r\nevent: message\r\ndata: {"id":1,\r\ndata: "result":{"content":[]}}\r\n\r\n`,
      ).result,
    ).toEqual({ content: [] });
  });
  it('distinguishes SSE errors, invalid JSON, and absent results', () => {
    expect(() => parseRpc('data: {"id":1,"error":{"message":"bad regex"}}\n\n')).toThrow('bad regex');
    expect(() => parseRpc('data: nope\n\n')).toThrow('Invalid JSON');
    expect(() => parseRpc('data: [DONE]\n\n')).toThrow('no JSON-RPC result');
  });
  it('maps all filters and retains snippets and URLs', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(rpc())));
    vi.stubGlobal('fetch', fetch);
    expect(
      await search({
        query: 'const',
        regex: true,
        caseSensitive: true,
        wholeWords: true,
        repo: 'facebook/react',
        path: 'src',
        lang: ['JavaScript'],
      }),
    ).toBe(match);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).params.arguments).toEqual({
      query: 'const',
      useRegexp: true,
      matchCase: true,
      matchWholeWords: true,
      repo: 'facebook/react',
      path: 'src',
      language: ['JavaScript'],
    });
  });
  it('distinguishes empty results, service errors, parse errors, HTTP failures', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(rpc('No results found for your query.'))));
    expect(await search({ query: 'x' })).toBe('No results found.');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(rpc('rate limited', true))));
    await expect(search({ query: 'x' })).rejects.toThrow('Search service error');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(rpc('unexpected'))));
    await expect(search({ query: 'x' })).rejects.toThrow('Unrecognized');
    fetch.mockResolvedValueOnce(new Response('no', { status: 429 }));
    await expect(search({ query: 'x' })).rejects.toThrow('HTTP 429');
  });
});

describe('limits and cancellation', () => {
  it('bounds output by lines and bytes, with a notice', () => {
    for (const text of ['x\n'.repeat(3000), '🙂'.repeat(30000)]) {
      const result = bounded(text, 'Narrow filters.');
      expect(result.details.truncation.truncated).toBe(true);
      expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(50 * 1024);
      expect(result.content[0]!.text.split('\n').length).toBeLessThanOrEqual(2000);
      expect(result.content[0]!.text).toContain('Output truncated');
    }
  });
  it('rejects oversized response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(MAX_BODY_BYTES + 1))));
    await expect(fetchText('https://example.com', {})).rejects.toThrow('byte limit');
  });
  it('keeps timeout active while consuming body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
              },
            }),
          ),
      ),
    );
    await expect(fetchText('https://example.com', {}, undefined, 10)).rejects.toThrow('timed out');
  });
});

describe('codefetch', () => {
  it('validates targets, explicit slash refs and line ranges', () => {
    expect(resolveTarget({ url: 'https://github.com/a/b/blob/main/src/a%20b.ts#L2' })).toEqual({
      repo: 'a/b',
      ref: 'main',
      path: 'src/a b.ts',
    });
    expect(resolveTarget({ repo: 'a/b', path: 'x', ref: 'feature/foo' }).ref).toBe('feature/foo');
    for (const params of [
      { repo: 'a/b', path: '../x' },
      { repo: 'a/b?x', path: 'x' },
      { repo: 'a/b', path: '/x' },
      { repo: 'a/b', path: 'x', startLine: 2, endLine: 1 },
      { url: 'https://evil.com/a/b/blob/main/x' },
    ])
      expect(() => resolveTarget(params)).toThrow();
  });
  it('slices inclusive lines without treating trailing newline as an extra line', async () => {
    const pi = gh();
    expect(await fetchFile(pi, { repo: 'a/b', path: 'x', ref: 'feature/foo', startLine: 2, endLine: 3 })).toMatchObject(
      { text: 'two\nthree', totalLines: 3 },
    );
    expect(pi.exec.mock.calls[0]![1]).toContain('repos/a/b/contents/x?ref=feature%2Ffoo');
    expect(pi.exec.mock.calls[0]![2].timeout).toBe(30000);
    expect(() => sliceLines('one', 2)).toThrow('exceeds');
    expect(() => sliceLines('one', 1.5)).toThrow('integers');
    expect(sliceLines('')).toMatchObject({ text: '', totalLines: 0 });
  });
  it('falls back after gh failure and throws on public failure', async () => {
    const pi = gh();
    pi.exec.mockRejectedValue(new Error('missing gh'));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('public', { headers: rawHeaders }))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchFile(pi, { repo: 'a/b', path: 'x' })).toMatchObject({ text: 'public' });
    await expect(fetchFile(pi, { repo: 'a/b', path: 'x' })).rejects.toThrow('HTTP 404');
  });
  it('rejects directory listings from both transports but accepts JSON file contents', async () => {
    const listing = '[{"name":"src","type":"dir"}]';
    const fetch = vi.fn().mockResolvedValue(new Response(listing, { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const params = { repo: 'a/b', path: 'src' };
    await expect(fetchFile(gh(listing, 'application/json'), params)).rejects.toThrow('Directories are not supported');
    expect(fetch).not.toHaveBeenCalled();
    const missing = gh();
    missing.exec.mockRejectedValue(new Error('missing gh'));
    await expect(fetchFile(missing, params)).rejects.toThrow('Directories are not supported');
    expect(await fetchFile(gh(listing), { ...params, path: 'data.json' })).toMatchObject({ text: listing });
  });
  it('does not fall back after aborting gh', async () => {
    const controller = new AbortController();
    const pi = gh();
    pi.exec.mockImplementation(async () => {
      controller.abort();
      throw new Error('cancelled');
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchFile(pi, { repo: 'a/b', path: 'x' }, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(pi.exec.mock.calls[0]![2].signal).toBe(controller.signal);
    await expect(fetchFile(pi, { repo: 'a/b', path: 'x' }, controller.signal)).rejects.toThrow();
    expect(pi.exec).toHaveBeenCalledTimes(1);
  });
});
