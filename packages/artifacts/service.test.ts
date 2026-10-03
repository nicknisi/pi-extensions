import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import artifacts from './index.js';
import { ARTIFACTS_SERVICE, isArtifactsAPI, isArtifactsOffer, type ArtifactsAPI } from './contract.js';
import { provideArtifacts } from './service.js';
import { annotationState, readAnnotations, writeAnnotations, type Annotation } from './feedback.js';
import { isRunning, setFeedbackSender, stopServer } from './server.js';
import { annotationsPath, openInBrowser, readArtifact, writeArtifact } from './utils.js';
import { renderRevisionComparison } from './review.js';

vi.mock('./utils.js', async (original) => ({
  ...(await original<typeof import('./utils.js')>()),
  openInBrowser: vi.fn(),
}));

function bus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(name: string, handler: (data: unknown) => void) {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    emit(name: string, data: unknown) {
      for (const handler of handlers.get(name) ?? []) handler(data);
    },
    count() {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}
function discover(events: ReturnType<typeof bus>, extra = {}) {
  const offers: unknown[] = [];
  events.emit(ARTIFACTS_SERVICE.discoveryEvent, { ...extra, offer: (offer: unknown) => offers.push(offer) });
  return offers;
}
const cwd = process.cwd();
let temp: string;
let events: ReturnType<typeof bus>;
let providers: ReturnType<typeof provideArtifacts>[];
const provider = (fallback = vi.fn(() => true)) => {
  const p = provideArtifacts(events, fallback);
  providers.push(p);
  return p;
};
const annotation = (id: string, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  comment: 'Please review',
  createdAt: new Date().toISOString(),
  ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const request = (url: string, path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') =>
  fetch(new URL(path, url), {
    method: method === 'PUT' ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'artifact-service-'));
  process.chdir(temp);
  events = bus();
  providers = [];
  vi.mocked(openInBrowser).mockClear();
});
afterEach(() => {
  for (const p of providers) p.dispose();
  setFeedbackSender(null);
  stopServer();
  process.chdir(cwd);
  rmSync(temp, { recursive: true, force: true });
});

it('publishing the same contract pushes a real SSE reload for the stable slug', async () => {
  const { api } = provider();
  const first = await api.publish({ title: 'Live contract', html: '<h1 id="change">Approved</h1>' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(new URL('/events', first.url), { signal: controller.signal });
    const reader = response.body!.getReader();
    const reload = (async () => {
      let text = '';
      while (!text.includes(`event: reload\ndata: ${first.slug}`)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE closed before reload');
        text += new TextDecoder().decode(chunk.value);
      }
      return text;
    })();
    const updated = await api.publish({ title: 'Live contract', html: '<h1 id="change">Verified</h1>' });
    expect(updated.url).toBe(first.url);
    expect(await reload).toContain(`event: reload\ndata: ${first.slug}`);
    expect(await (await fetch(first.url)).text()).toContain('Verified');
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
});

async function firstEvent(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const reader = (await fetch(url, { signal: controller.signal })).body!.getReader();
    let text = '';
    while (!/event: \w+\ndata: /.test(text)) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return text;
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    return text;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

it('one shared live stream per page, released while hidden, with missed changes replayed', async () => {
  const { EVENT_HUB_JS } = await import('./events.js');
  const { runInNewContext } = await import('node:vm');
  const streams: { url: string; closed: boolean; listeners: Record<string, (e: unknown) => void> }[] = [];
  const docListeners: Record<string, () => void> = {};
  const winListeners: Record<string, () => void> = {};
  const document = {
    visibilityState: 'visible',
    addEventListener: (t: string, f: () => void) => (docListeners[t] = f),
  };
  class EventSource {
    s = { url: '', closed: false, listeners: {} as Record<string, (e: unknown) => void> };
    constructor(url: string) {
      this.s.url = url;
      streams.push(this.s);
    }
    addEventListener(t: string, f: (e: unknown) => void) {
      this.s.listeners[t] = f;
    }
    close() {
      this.s.closed = true;
    }
  }
  const window: Record<string, unknown> = { addEventListener: (t: string, f: () => void) => (winListeners[t] = f) };
  const context = {
    window,
    document,
    EventSource,
    performance: { timeOrigin: 1000 },
    Date,
    setTimeout: (f: () => void) => f(),
  };
  runInNewContext(EVENT_HUB_JS + EVENT_HUB_JS, context); // baked snippet + review layer both include it
  const hub = window.__artifactEvents as { on: (slug: string, type: string, fn: (e: unknown) => void) => void };
  const seen: string[] = [];
  hub.on('page', 'reload', () => seen.push('reload'));
  hub.on('page', 'annotations', () => seen.push('annotations'));
  expect(streams).toHaveLength(1);
  expect(streams[0]!.url).toBe('/events?slug=page&since=1000');
  streams[0]!.listeners.annotations!({ data: 'page' });
  expect(seen).toEqual(['annotations']);
  document.visibilityState = 'hidden';
  docListeners.visibilitychange!();
  expect(streams[0]!.closed).toBe(true);
  document.visibilityState = 'visible';
  docListeners.visibilitychange!();
  expect(streams).toHaveLength(2);
  expect(Number(new URL(streams[1]!.url, 'http://x').searchParams.get('since'))).toBeGreaterThan(1000);

  // Server replays a change made while the page was disconnected.
  const { api } = provider();
  const page = await api.publish({ title: 'Replay page', html: '<p>one</p>' });
  const before = Date.now() - 5000;
  const events = new URL(`/events?slug=${page.slug}&since=${before}`, page.url).href;
  expect(await firstEvent(events)).toContain(`event: reload\ndata: ${page.slug}`);
  const fresh = new URL(`/events?slug=${page.slug}&since=${Date.now() + 60000}`, page.url).href;
  expect(await firstEvent(fresh)).not.toContain('event:');
});

it('already-written pages are served with the shared stream instead of their old baked listener', async () => {
  const { api } = provider();
  const page = await api.publish({ title: 'Old page', html: '<p>old</p>' });
  const file = readArtifact(page.slug)!;
  const legacy = file.replace(
    /<script data-artifact-reload>[\s\S]*?<\/script>/,
    '<script data-artifact-reload>var es = new EventSource("/events");</script>',
  );
  writeArtifact(page.slug, legacy);
  const served = await (await fetch(page.url)).text();
  expect(served).not.toContain('var es = new EventSource');
  expect(served).toContain('__artifactEvents.on(');
});

it('offers synchronously to multiple consumers, rejects mismatches, and validates own callable methods', () => {
  const p = provider();
  expect(isRunning()).toBe(false);
  const first = discover(events);
  const second = discover(events);
  expect(first).toHaveLength(1);
  expect(first).toEqual(second);
  expect(isArtifactsOffer(first[0])).toBe(true);
  expect(discover(events, { apiMajor: 2 })).toEqual([]);
  expect(discover(events, { id: 'other' })).toEqual([]);
  expect(isArtifactsOffer({ id: ARTIFACTS_SERVICE.id, apiMajor: 2, api: p.api })).toBe(false);
  expect(isArtifactsAPI(Object.create(p.api))).toBe(false);
  expect(isArtifactsAPI({ ...p.api, publish: 1 })).toBe(false);
  const getter = vi.fn(() => p.api.publish);
  expect(
    isArtifactsAPI({
      ...p.api,
      get publish() {
        return getter();
      },
    }),
  ).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  p.dispose();
  expect(events.count()).toBe(0);
  expect(discover(events)).toEqual([]);
});

it('publishes ordered same-slug updates, preserves sidecars/anchors and previous revision, answers without rewriting', async () => {
  const { api } = provider();
  const first = await api.publish({
    title: 'Stable Report',
    html: '<!doctype html><html><body><h1 id="summary" data-artifact-anchor="summary">First</h1></body></html>',
  });
  expect(Object.keys(first).sort()).toEqual(['absPath', 'slug', 'url']);
  expect(first.slug).toBe('stable-report');
  const question = annotation('q', { intent: 'question', sentAt: new Date().toISOString() });
  writeAnnotations(first.slug, [
    question,
    annotation('keep', { intent: 'keep', element: { selector: '#summary', label: 'Summary' } }),
  ]);
  const before = readFileSync(annotationsPath(first.slug), 'utf8');
  const evidencePath = join(temp, '.pi/artifacts/stable-report.evidence.json');
  writeFileSync(evidencePath, 'evidence');
  const second = await api.publish({
    title: 'Stable Report',
    html: '<h1 id="summary" data-artifact-anchor="summary">Second</h1>',
    open: false,
  });
  const third = await api.publish({
    title: 'Stable Report',
    html: '<h1 id="summary" data-artifact-anchor="summary">Third</h1>',
  });
  expect(second).toEqual(first);
  expect(third).toEqual(first);
  expect(openInBrowser).not.toHaveBeenCalled();
  const opened = await api.publish({ title: 'Explicit Open', html: 'Open', open: true });
  expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(opened.url);
  expect(readArtifact(first.slug)).toContain('data-artifact-anchor="summary"');
  expect(readArtifact(first.slug)).toContain('Third');
  expect(renderRevisionComparison(first.slug)).toContain('Second');
  expect(readFileSync(annotationsPath(first.slug), 'utf8')).toBe(before);
  expect(readFileSync(evidencePath, 'utf8')).toBe('evidence');
  const page = readArtifact(first.slug);
  expect(await api.answer({ slug: first.slug, annotationId: 'q', content: 'Because.' })).toEqual({ ok: true });
  expect(readArtifact(first.slug)).toBe(page);
  expect(readAnnotations(first.slug)[0]?.reply).toBe('Because.');
  expect(await (await fetch(first.url)).text()).toContain('Because.');
  await expect(api.publish({ title: '', html: '' })).rejects.toThrow('title');
  await expect(api.publish({ title: 'Huge', html: 'é'.repeat(1024 * 1024 + 1) })).rejects.toThrow('2 MB');
  await expect(api.answer({ slug: '../bad', annotationId: 'q', content: 'bad' })).rejects.toThrow('slug');
});

it('guards retained methods, stale disposal and stale unsubscribe without clearing a new owner', async () => {
  const old = provider();
  const { publish, answer, subscribe } = old.api;
  const release = await subscribe({ slug: 'x', onFeedback: () => true });
  release();
  await subscribe({ slug: 'x', onFeedback: () => true });
  release();
  await expect(subscribe({ slug: 'x', onFeedback: () => true })).rejects.toThrow('already');
  const fallback = vi.fn(() => true);
  const fresh = provider(fallback);
  old.dispose();
  old.dispose();
  await expect(publish({ title: 'x', html: 'x' })).rejects.toThrow('disposed');
  await expect(answer({ slug: 'x', annotationId: 'q', content: 'a' })).rejects.toThrow('disposed');
  await expect(subscribe({ slug: 'x', onFeedback: () => true })).rejects.toThrow('disposed');
  const result = await fresh.api.publish({ title: 'x', html: 'x' });
  writeAnnotations('x', [annotation('a')]);
  expect((await request(result.url, '/api/feedback', { slug: 'x' })).status).toBe(200);
  expect(fallback).toHaveBeenCalledOnce();
  expect(discover(events)).toHaveLength(1);
});

it.each(['false', 'reject'] as const)(
  'awaits subscriber %s, never falls back, locks same-slug sends and saves, preserves other replies',
  async (failure) => {
    const fallback = vi.fn(() => true);
    const { api } = provider(fallback);
    const { slug, url } = await api.publish({ title: 'Review', html: '<h1>Review</h1>' });
    const original = annotation('old', { intent: 'question', sentAt: '2020-01-01' });
    writeAnnotations(slug, [original, annotation('draft')]);
    const entered = deferred<void>();
    const finish = deferred<boolean>();
    const receiver = vi.fn(async (feedback) => {
      expect(feedback).toEqual({ slug, markdown: expect.any(String), annotationIds: ['draft'] });
      entered.resolve();
      await finish.promise;
      if (failure === 'reject') throw new Error('owner unavailable');
      return false;
    });
    const off = await api.subscribe({ slug, onFeedback: receiver });
    await expect(api.subscribe({ slug, onFeedback: receiver })).rejects.toThrow('already');
    const sending = request(url, '/api/feedback', { slug });
    await entered.promise;
    expect((await request(url, '/api/feedback', { slug })).status).toBe(409);
    expect((await request(url, '/api/annotations', { slug, annotations: [annotation('new')] }, 'PUT')).status).toBe(
      409,
    );
    await api.answer({ slug, annotationId: 'old', content: 'Preserved answer' });
    // A different slug remains usable while this owner awaits.
    writeArtifact('other', '<p>Other</p>');
    writeAnnotations('other', [annotation('other-draft')]);
    expect((await request(url, '/api/feedback', { slug: 'other' })).status).toBe(200);
    expect(fallback).toHaveBeenCalledTimes(1);
    finish.resolve(false);
    expect((await sending).status).toBe(503);
    expect(receiver).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(readAnnotations(slug)).toEqual([
      { ...original, reply: 'Preserved answer' },
      annotation('draft', { createdAt: readAnnotations(slug)[1]!.createdAt }),
    ]);
    off();
    expect((await request(url, '/api/feedback', { slug })).status).toBe(200);
    expect(fallback).toHaveBeenCalledTimes(2);
  },
);

it('awaits success and does not deliver drafts twice', async () => {
  const { api } = provider();
  const { slug, url } = await api.publish({ title: 'Success', html: 'Success' });
  writeAnnotations(slug, [annotation('draft')]);
  const entered = deferred<void>();
  const finish = deferred<boolean>();
  await api.subscribe({
    slug,
    onFeedback: () => {
      entered.resolve();
      return finish.promise;
    },
  });
  const pending = request(url, '/api/feedback', { slug });
  await entered.promise;
  expect((await request(url, '/api/feedback', { slug })).status).toBe(409);
  finish.resolve(true);
  expect((await pending).status).toBe(200);
  expect((await request(url, '/api/feedback', { slug })).status).toBe(400);
  expect(annotationState(slug).annotations[0]?.sentAt).toBeTruthy();
});

it('disposal during delivery rolls back in the original project and never routes to a replacement session', async () => {
  const old = provider();
  const { slug, url } = await old.api.publish({ title: 'Session', html: 'Session' });
  writeAnnotations(slug, [annotation('draft')]);
  const entered = deferred<void>();
  const finish = deferred<boolean>();
  await old.api.subscribe({
    slug,
    onFeedback: () => {
      entered.resolve();
      return finish.promise;
    },
  });
  const pending = request(url, '/api/feedback', { slug });
  await entered.promise;
  old.dispose();
  const other = mkdtempSync(join(tmpdir(), 'artifact-other-'));
  try {
    process.chdir(other);
    const fallback = vi.fn(() => true);
    provider(fallback);
    writeArtifact(slug, 'Different project');
    writeAnnotations(slug, [annotation('different')]);
    expect((await pending).status).toBe(503);
    // The abandoned receiver need not settle for shutdown to release the lock.
    finish.resolve(true);
    expect(readAnnotations(slug)[0]?.id).toBe('different');
    expect(readAnnotations(slug, temp)[0]?.sentAt).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  } finally {
    process.chdir(temp);
    rmSync(other, { recursive: true, force: true });
  }
});

it('factory registers discovery immediately, restarts after shutdown, and preserves ordinary fallback', async () => {
  const hooks = new Map<string, () => void>();
  const sendUserMessage = vi.fn();
  artifacts({
    events,
    on: (name: string, fn: () => void) => hooks.set(name, fn),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    sendUserMessage,
  } as unknown as ExtensionAPI);
  const factoryAPI = (discover(events)[0] as { api: ArtifactsAPI }).api;
  hooks.get('session_start')!();
  const old = (discover(events)[0] as { api: ArtifactsAPI }).api;
  expect(old).toBe(factoryAPI);
  const first = await old.publish({ title: 'Lifecycle', html: 'First' });
  writeAnnotations(first.slug, [annotation('first')]);
  expect((await request(first.url, '/api/feedback', { slug: first.slug })).status).toBe(200);
  expect(sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: 'followUp' });
  await old.subscribe({ slug: first.slug, onFeedback: () => false });
  hooks.get('session_shutdown')!();
  expect(isRunning()).toBe(false);
  expect(events.count()).toBe(0);
  hooks.get('session_start')!();
  const fresh = (discover(events)[0] as { api: ArtifactsAPI }).api;
  await expect(old.publish({ title: 'Lifecycle', html: 'Stale' })).rejects.toThrow('disposed');
  const second = await fresh.publish({ title: 'Lifecycle', html: 'Second' });
  writeAnnotations(second.slug, [annotation('second')]);
  expect((await request(second.url, '/api/feedback', { slug: second.slug })).status).toBe(200);
  expect(sendUserMessage).toHaveBeenCalledTimes(2);
  hooks.get('session_shutdown')!();
});

it('keeps ordinary tool decisions/evidence and default open behavior unchanged', async () => {
  let tool!: Parameters<ExtensionAPI['registerTool']>[0];
  const hooks = new Map<string, () => void>();
  artifacts({
    events,
    on: (name: string, fn: () => void) => hooks.set(name, fn),
    registerCommand: vi.fn(),
    registerTool: (definition: typeof tool) => {
      tool = definition;
    },
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI);
  hooks.get('session_start')!();
  const ctx = { ui: { setStatus: vi.fn(), theme: { fg: (_color: string, text: string) => text } } };
  const run = (params: Record<string, unknown>) => tool.execute('test', params, undefined, undefined, ctx as never);
  try {
    await run({
      action: 'create',
      kind: 'html',
      title: 'Ordinary',
      content: '<h1>Claim</h1>',
      decisions: [
        {
          id: 'choice',
          question: 'Which?',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      ],
      evidence: [{ id: 'proof', title: 'Proof', source: 'test.ts:1' }],
    });
    expect(openInBrowser).toHaveBeenCalledOnce();
    expect(readArtifact('ordinary')).toContain('data-artifact-decision="choice"');
    expect(readArtifact('ordinary')).toContain('id="artifact-evidence-proof"');
    writeAnnotations('ordinary', [annotation('keep', { intent: 'keep' })]);
    await run({ action: 'update', kind: 'html', title: 'Ordinary', content: '<h1>Updated</h1>' });
    expect(openInBrowser).toHaveBeenCalledOnce();
    expect(readArtifact('ordinary')).not.toContain('data-artifact-decision="choice"');
    expect(readAnnotations('ordinary')[0]?.intent).toBe('keep');
  } finally {
    hooks.get('session_shutdown')!();
  }
});

it('concurrent publishes share one lazy server and cancelled startup cannot resurrect it', async () => {
  const p = provider();
  const [a, b] = await Promise.all([
    p.api.publish({ title: 'Concurrent', html: 'First' }),
    p.api.publish({ title: 'Concurrent', html: 'Last' }),
  ]);
  expect(a).toEqual(b);
  expect(readArtifact(a.slug)).toContain('Last');
  stopServer();
  const pending = p.api.publish({ title: 'Cancelled', html: 'Cancelled' });
  p.dispose();
  stopServer();
  await expect(pending).rejects.toThrow();
  expect(isRunning()).toBe(false);
});

it('page requests reach only the live owner, only for accepted actions, and never from another origin', async () => {
  const { api } = provider();
  const page = await api.publish({
    title: 'Request page',
    html: '<button type="button" data-artifact-action="approve" hidden>Approve in Pi</button>',
  });
  const served = await (await fetch(page.url)).text();
  expect(served).toContain('data-artifact-requests');
  const actions = async () => (await (await fetch(new URL(`/api/actions?slug=${page.slug}`, page.url))).json()).actions;
  const ask = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(new URL('/api/request', page.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  // Nobody listening: nothing is offered and a request is refused.
  expect(await actions()).toEqual([]);
  expect((await ask({ slug: page.slug, action: 'approve' })).status).toBe(409);

  const received: unknown[] = [];
  await expect(api.subscribe({ slug: page.slug, onFeedback: () => true, actions: ['approve'] })).rejects.toThrow(
    /onRequest/,
  );
  await expect(
    api.subscribe({ slug: page.slug, onFeedback: () => true, actions: ['Approve!'], onRequest: () => true }),
  ).rejects.toThrow(/actions/);
  const release = await api.subscribe({
    slug: page.slug,
    onFeedback: () => true,
    actions: ['approve'],
    onRequest: (request) => {
      received.push(request);
      return true;
    },
  });
  expect(await actions()).toEqual(['approve']);
  const ok = await ask({ slug: page.slug, action: 'approve' });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ delivered: true });
  expect(received).toEqual([{ slug: page.slug, action: 'approve' }]);

  // Unaccepted actions, foreign origins and non-JSON posts never reach the owner.
  expect((await ask({ slug: page.slug, action: 'accept' })).status).toBe(409);
  expect((await ask({ slug: page.slug, action: 'approve' }, { Origin: 'http://evil.example' })).status).toBe(403);
  const form = await fetch(new URL('/api/request', page.url), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ slug: page.slug, action: 'approve' }),
  });
  expect(form.status).toBe(403);
  expect(received).toHaveLength(1);

  release();
  expect(await actions()).toEqual([]);
  expect((await ask({ slug: page.slug, action: 'approve' })).status).toBe(409);
});

it('a failed or slow owner answers 503 or 409 instead of pretending delivery', async () => {
  const { api } = provider();
  const page = await api.publish({ title: 'Slow owner', html: '<p>page</p>' });
  const gate = deferred<boolean>();
  await api.subscribe({ slug: page.slug, onFeedback: () => true, actions: ['approve'], onRequest: () => gate.promise });
  const ask = () =>
    fetch(new URL('/api/request', page.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: page.slug, action: 'approve' }),
    });
  const first = ask();
  await new Promise((r) => setTimeout(r, 50));
  expect((await ask()).status).toBe(409);
  gate.resolve(false);
  expect((await first).status).toBe(503);
});

it('a baked or file copy carries no request wiring', async () => {
  const { api } = provider();
  const page = await api.publish({
    title: 'Baked page',
    html: '<button data-artifact-action="approve" hidden>Go</button>',
  });
  expect(readArtifact(page.slug)).not.toContain('data-artifact-requests');
});

it('a request carrying another host name (DNS rebinding) is refused', async () => {
  const { api } = provider();
  const page = await api.publish({ title: 'Rebind page', html: '<p>page</p>' });
  const received: unknown[] = [];
  await api.subscribe({
    slug: page.slug,
    onFeedback: () => true,
    actions: ['approve'],
    onRequest: (r) => (received.push(r), true),
  });
  const { port } = new URL(page.url);
  const body = JSON.stringify({ slug: page.slug, action: 'approve' });
  const { request: send } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = send(
      {
        host: '127.0.0.1',
        port,
        path: '/api/request',
        method: 'POST',
        headers: {
          Host: `attacker.example:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  expect(status).toBe(403);
  expect(received).toEqual([]);
});
