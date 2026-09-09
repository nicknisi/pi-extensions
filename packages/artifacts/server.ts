/** Lazy localhost HTTP server: static artifact serving, index page, SSE live reload. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { HOST } from './config.js';
import { isSafeSlug, listArtifacts, readArtifact, safeArtifactPath } from './utils.js';
import { renderCommentMarkdown, renderIndexPage } from './templates.js';
import { injectAnnotations } from './annotate.js';
import { renderRevisionComparison } from './review.js';
import {
  artifactText,
  composeFeedback,
  annotationState,
  validAnnotation,
  isStale,
  shareBaked,
  sourceLine,
  writeAnnotations,
  type Annotation,
} from './feedback.js';

interface ServerState {
  port: number;
  server: Server;
  clients: Set<ServerResponse>;
}

let state: ServerState | null = null;

/** Delivers a composed feedback message to the live session. false/throw → 503. */
export type FeedbackSender = (markdown: string) => boolean;

let feedbackSender: FeedbackSender | null = null;

/** Register (or clear) the feedback sender. Called by the extension per session. */
export function setFeedbackSender(fn: FeedbackSender | null): void {
  feedbackSender = fn;
}

/** URL for a given slug (or index). Starts the server if needed. */
export async function artifactUrl(slug?: string): Promise<string> {
  const port = await ensureServer();
  return slug ? `http://${HOST}:${port}/${slug}.html` : `http://${HOST}:${port}/`;
}

/** Push a reload event for a slug to all connected SSE clients. No-op if server isn't running. */
export function notifyReload(slug: string): void {
  if (!state) return;
  const payload = `event: reload\ndata: ${slug}\n\n`;
  for (const res of state.clients) {
    try {
      res.write(payload);
    } catch {
      state.clients.delete(res);
    }
  }
}

/** Refresh review records without reloading the document or losing a draft. */
export function notifyAnnotations(slug: string): void {
  if (!state) return;
  for (const res of state.clients) res.write(`event: annotations\ndata: ${slug}\n\n`);
}

/** Whether the server is currently running (used by `list` to decide whether to include URLs). */
export function isRunning(): boolean {
  return state !== null;
}

/** Current port if the server is running, else null. Does NOT start the server. */
export function runningPort(): number | null {
  return state ? state.port : null;
}

/** Start the server if not already running. Returns the port. */
export async function ensureServer(): Promise<number> {
  if (state) return state.port;

  const clients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    void handle(req, res, clients).catch((error: unknown) => {
      if (!res.headersSent)
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'artifact request failed' });
      else res.end();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  state = { port, server, clients };
  return port;
}

/** Stop the server (used on session shutdown). */
export function stopServer(): void {
  if (!state) return;
  for (const res of state.clients) {
    try {
      res.end();
    } catch {}
  }
  state.clients.clear();
  state.server.close();
  state = null;
}

// ─── Request handler ──────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
};

const BODY_CAP = 1024 * 1024; // 1 MB

/** Accumulate a request body with a hard cap; destroys + 413 past it. Resolves null when capped. */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let capped = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_CAP) {
        capped = true;
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('413 — body too large');
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!capped) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', () => {
      if (!capped) resolve(null);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** PUT /api/annotations replaces drafts but cannot change or erase sent feedback. */
async function handlePutAnnotations(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req, res);
  if (raw === null) return; // 413 already sent
  let body: { slug?: unknown; annotations?: unknown; revision?: unknown };
  try {
    body = JSON.parse(raw) ?? {};
  } catch {
    sendJson(res, 400, { error: 'malformed JSON' });
    return;
  }
  if (typeof body.slug !== 'string' || !isSafeSlug(body.slug)) {
    sendJson(res, 400, { error: 'invalid slug' });
    return;
  }
  if (!readArtifact(body.slug)) {
    sendJson(res, 404, { error: 'no such artifact' });
    return;
  }
  if (
    !Array.isArray(body.annotations) ||
    body.annotations.length > 1000 ||
    !body.annotations.every(validAnnotation) ||
    new Set(body.annotations.map((a: Annotation) => a.id)).size !== body.annotations.length
  ) {
    sendJson(res, 400, { error: 'invalid annotations' });
    return;
  }
  const current = annotationState(body.slug);
  if (body.revision !== undefined && body.revision !== current.revision) {
    sendJson(res, 409, { error: 'Review changed in another tab. Copy your unsaved feedback before reloading.' });
    return;
  }
  const sent = current.annotations.filter((a) => a.sentAt);
  const sentIds = new Set(sent.map((a) => a.id));
  const drafts = (body.annotations as Annotation[])
    .filter((a) => !sentIds.has(a.id))
    .map((a) => {
      const { sentAt: _sentAt, reply: _reply, ...draft } = a;
      return draft;
    });
  writeAnnotations(body.slug, [...sent, ...drafts]);
  sendJson(res, 200, { ok: true, ...annotationState(body.slug) });
}

/** POST /api/feedback delivers only drafts and retains a durable sent batch. */
async function handlePostFeedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req, res);
  if (raw === null) return; // 413 already sent
  let body: { slug?: unknown; revision?: unknown };
  try {
    body = JSON.parse(raw) ?? {};
  } catch {
    sendJson(res, 400, { error: 'malformed JSON' });
    return;
  }
  if (typeof body.slug !== 'string' || !isSafeSlug(body.slug)) {
    sendJson(res, 400, { error: 'invalid slug' });
    return;
  }
  const slug = body.slug;
  const current = annotationState(slug);
  if (body.revision !== undefined && body.revision !== current.revision) {
    sendJson(res, 409, { error: 'Review changed. Copy unsaved feedback before reloading.' });
    return;
  }
  const anns = current.annotations.filter((a) => !a.sentAt);
  if (anns.length === 0) {
    sendJson(res, 400, { error: 'no annotations' });
    return;
  }

  const text = artifactText(slug);
  const staleFlags = anns.map((a) => (text === null ? true : isStale(a, text)));
  const lines = anns.map((a) => sourceLine(a, slug));
  const url = state ? `http://${HOST}:${state.port}/${slug}.html` : `/${slug}.html`;
  const feedback = composeFeedback(slug, url, anns, staleFlags, lines);

  if (!feedbackSender) {
    sendJson(res, 503, { delivered: false, feedback });
    return;
  }
  // Persist first so a successful delivery cannot be followed by a failed archive write.
  const sentAt = new Date().toISOString();
  writeAnnotations(
    slug,
    current.annotations.map((a) => (a.sentAt ? a : { ...a, sentAt })),
  );
  let delivered = false;
  try {
    delivered = feedbackSender(feedback) !== false;
  } catch {
    delivered = false;
  }
  if (delivered) {
    sendJson(res, 200, { delivered: true, ...annotationState(slug) });
  } else {
    writeAnnotations(slug, current.annotations);
    sendJson(res, 503, { delivered: false, feedback });
  }
}

/** POST /api/render — render comment markdown to HTML for the annotation UI. */
async function handleRender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req, res);
  if (raw === null) return; // 413 already sent
  let body: { markdown?: unknown };
  try {
    body = JSON.parse(raw) ?? {};
  } catch {
    sendJson(res, 400, { error: 'malformed JSON' });
    return;
  }
  if (typeof body.markdown !== 'string') {
    sendJson(res, 400, { error: 'markdown must be a string' });
    return;
  }
  sendJson(res, 200, { html: renderCommentMarkdown(body.markdown) });
}

/** POST /api/share — the in-page Share button: copy the file or create a gist. */
async function handleShare(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req, res);
  if (raw === null) return; // 413 already sent
  let body: { slug?: unknown; method?: unknown };
  try {
    body = JSON.parse(raw) ?? {};
  } catch {
    sendJson(res, 400, { error: 'malformed JSON' });
    return;
  }
  if (typeof body.slug !== 'string' || !isSafeSlug(body.slug)) {
    sendJson(res, 400, { error: 'invalid slug' });
    return;
  }
  const method = body.method;
  if (method !== 'copy' && method !== 'gist' && method !== 'image' && method !== 'pdf') {
    sendJson(res, 400, { error: 'method must be copy, gist, image, or pdf' });
    return;
  }
  const html = readArtifact(body.slug);
  if (html == null) {
    sendJson(res, 404, { error: 'no such artifact' });
    return;
  }
  const title = html.match(/<title>(.*?)<\/title>/s)?.[1]?.trim() || body.slug;
  try {
    // handleShare only runs on a live server, so state is set.
    const result = await shareBaked(body.slug, title, method, { baseUrl: `http://${HOST}:${state!.port}` });
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, clients: Set<ServerResponse>): Promise<void> {
  const parsedUrl = new URL(req.url ?? '/', `http://${HOST}`);
  const url = parsedUrl.pathname;
  if (url.startsWith('/api/') && req.method !== 'GET') {
    const origin = req.headers.origin;
    if (
      (origin && origin !== `http://${HOST}:${state?.port}`) ||
      !req.headers['content-type']?.startsWith('application/json')
    ) {
      sendJson(res, 403, { error: 'same-origin JSON requests required' });
      return;
    }
  }
  if (req.method === 'GET' && (url === '/api/annotations' || url === '/api/revision')) {
    const slug = parsedUrl.searchParams.get('slug');
    if (!slug || !isSafeSlug(slug)) {
      sendJson(res, 400, { error: 'invalid slug' });
      return;
    }
    if (!readArtifact(slug)) {
      sendJson(res, 404, { error: 'no such artifact' });
      return;
    }
    if (url === '/api/annotations') {
      sendJson(res, 200, annotationState(slug));
      return;
    }
    const comparison = renderRevisionComparison(slug);
    res.writeHead(comparison ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(comparison ?? '<p>No previous revision yet. Update this artifact to compare revisions.</p>');
    return;
  }

  // Feedback endpoints (before the static-file fallthrough)
  if (url === '/api/share' && req.method === 'POST') {
    await handleShare(req, res);
    return;
  }
  if (url === '/api/render' && req.method === 'POST') {
    await handleRender(req, res);
    return;
  }
  if (url === '/api/annotations' && req.method === 'PUT') {
    await handlePutAnnotations(req, res);
    return;
  }
  if (url === '/api/feedback' && req.method === 'POST') {
    await handlePostFeedback(req, res);
    return;
  }

  // SSE endpoint
  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Index page
  if (url === '/') {
    const entries = listArtifacts();
    const html = renderIndexPage(entries);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Static artifact file — normalize + prefix-check to prevent traversal outside artifacts dir
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    sendJson(res, 400, { error: 'invalid URL encoding' });
    return;
  }
  const safe = safeArtifactPath(decoded);
  if (!safe || !existsSync(safe) || !statSync(safe).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — artifact not found');
    return;
  }

  const ext = extname(safe).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';

  // Inject the annotation layer at serve time into .html artifact pages only —
  // the stored file stays byte-clean.
  if (ext === '.html') {
    const slug = basename(safe).replace(/\.html$/, '');
    const review = annotationState(slug);
    const injected = injectAnnotations(readFileSync(safe, 'utf-8'), slug, JSON.stringify(review.annotations), {
      revision: review.revision,
    });
    res.writeHead(200, { 'Content-Type': mime });
    res.end(injected);
    return;
  }

  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(safe));
}
