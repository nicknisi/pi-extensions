import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  annotationState,
  answerQuestion,
  bakeAnnotations,
  isStale,
  readAnnotations,
  writeAnnotations,
  type Annotation,
} from './feedback.js';
import { ensureServer, setFeedbackSender, stopServer } from './server.js';
import { annotationsPath, artifactPath, writeArtifact, writeSourceMirror } from './utils.js';
import { renderCommentMarkdown, renderMarkdownDocument } from './templates.js';
import { renderReviewContent, renderRevisionComparison, savePreviousRevision } from './review.js';

const cwd = process.cwd();
let temp: string;
let base: string;
const slug = 'review-test';
const annotation = (id: string, fields: Partial<Annotation> = {}): Annotation => ({
  id,
  comment: 'Review this\n\nKeep paragraph breaks.',
  createdAt: new Date().toISOString(),
  ...fields,
});
const request = (path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') =>
  fetch(base + path, {
    method: method === 'PUT' ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  temp = mkdtempSync(join(tmpdir(), 'artifact-feedback-'));
  process.chdir(temp);
  writeArtifact(slug, renderMarkdownDocument('Review test', slug, '# Original\n\nRepeat. Middle. Repeat. End.'));
  writeSourceMirror(slug, '# Original\n\nRepeat. Middle. Repeat. End.');
  base = `http://127.0.0.1:${await ensureServer()}`;
});
afterEach(() => {
  setFeedbackSender(null);
  stopServer();
  process.chdir(cwd);
  rmSync(temp, { recursive: true, force: true });
});

it('sends general, keep, element, question and decision feedback once and preserves the sent records', async () => {
  const list = [
    annotation('general'),
    annotation('keep', { intent: 'keep', quote: { exact: 'Original' } }),
    annotation('pin', { element: { selector: '#chart', label: 'Chart' } }),
    annotation('question', { intent: 'question', comment: 'Why?' }),
    annotation('decision', {
      intent: 'decision',
      decisionId: 'storage',
      decisionValues: ['sqlite'],
      comment: 'Storage: SQLite (sqlite)',
    }),
  ];
  expect(
    (await request('/api/annotations', { slug, annotations: list, revision: annotationState(slug).revision }, 'PUT'))
      .status,
  ).toBe(200);
  const failed = await request('/api/feedback', { slug });
  expect(failed.status).toBe(503);
  expect(readAnnotations(slug).every((a) => !a.sentAt)).toBe(true);
  let message = '';
  let count = 0;
  setFeedbackSender((text) => {
    message = text;
    count++;
    return true;
  });
  const sent = await request('/api/feedback', { slug, revision: annotationState(slug).revision });
  expect(sent.status).toBe(200);
  expect(message).toContain('Whole artifact');
  expect(message).toContain('[keep]');
  expect(message).toContain('Element: Chart');
  expect(message).toContain('not an edit');
  expect(message).toContain('annotationId: question');
  expect(message).toContain('do not authorize');
  expect(readAnnotations(slug)).toHaveLength(5);
  expect(readAnnotations(slug).every((a) => a.sentAt)).toBe(true);
  expect((await request('/api/feedback', { slug })).status).toBe(400);
  expect(count).toBe(1);
  expect((await request('/api/annotations', { slug, annotations: [] }, 'PUT')).status).toBe(200);
  expect(readAnnotations(slug)).toHaveLength(5);
  const original = readFileSync(artifactPath(slug), 'utf8');
  answerQuestion(slug, 'question', 'Because it is simpler.');
  expect(readAnnotations(slug).find((a) => a.id === 'question')?.reply).toBe('Because it is simpler.');
  expect(readFileSync(artifactPath(slug), 'utf8')).toBe(original);
  expect(() => answerQuestion(slug, 'general', 'Wrong target')).toThrow();
  const hydration = await (await fetch(`${base}/${slug}.html`)).text();
  expect(hydration).toContain('Because it is simpler.');
  const shared = bakeAnnotations(slug)!;
  expect(shared.count).toBe(5);
  expect(shared.html).toContain('static: true');
  expect(shared.html).not.toContain('<iframe');
  expect(shared.html).not.toContain('<script data-artifact-reload>');
});

it("restarts on the project's previous port, and on a fresh one when that port is taken", async () => {
  const port = Number(new URL(base).port);
  stopServer();
  expect(await ensureServer()).toBe(port);
  stopServer();
  const blocker = createNetServer();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  try {
    const moved = await ensureServer();
    expect(moved).not.toBe(port);
    expect(readFileSync(join(process.cwd(), '.pi', 'artifacts', '.server-port'), 'utf8')).toBe(String(moved));
  } finally {
    blocker.close();
  }
});

it('answers only requests addressed to this server by host (DNS rebinding)', async () => {
  const port = new URL(base).port;
  const status = (path: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}${path}`, { headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  for (const path of [`/api/annotations?slug=${slug}`, `/${slug}.html`, `/c/${slug}.html`]) {
    expect(await status(path, `rebind.example:${port}`)).toBe(403);
    expect(await status(path, `127.0.0.1:${Number(port) + 1}`)).toBe(403);
  }
  // The review page and API answer on 127.0.0.1; the artifact itself only on localhost.
  expect(await status(`/api/annotations?slug=${slug}`, `127.0.0.1:${port}`)).toBe(200);
  expect(await status(`/${slug}.html`, `127.0.0.1:${port}`)).toBe(200);
  expect(await status(`/c/${slug}.html`, `127.0.0.1:${port}`)).toBe(404);
  expect(await status(`/c/${slug}.html`, `localhost:${port}`)).toBe(200);
  expect(await status(`/api/annotations?slug=${slug}`, `localhost:${port}`)).toBe(404);
  expect(await status(`/${slug}.html`, `localhost:${port}`)).toBe(404);
});

it('keeps the artifact on its own origin, away from the API and review state', async () => {
  const port = new URL(base).port;
  const content = `http://localhost:${port}`;
  writeAnnotations(slug, [annotation('a', { quote: { exact: 'Original' } })]);
  // The review page frames the document from the other origin and cannot itself be framed.
  const page = await fetch(`${base}/${slug}.html`);
  expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  expect(await page.text()).toContain(
    `<iframe id="artifact-frame" title="Review test" src="${content}/c/${slug}.html"`,
  );
  const doc = await fetch(`${content}/c/${slug}.html`);
  expect(doc.headers.get('content-security-policy')).toBe(`frame-ancestors http://127.0.0.1:${port}`);
  const docHtml = await doc.text();
  expect(docHtml).toContain('data-artifact-bridge');
  expect(docHtml).not.toContain('data-artifact-reload');
  expect(docHtml).not.toContain('/api/');
  // Share renders get the read-only layer instead of the bridge.
  expect(await (await fetch(`${content}/c/${slug}.html?panel=open`)).text()).toContain('static: true');
  for (const path of [
    `${slug}.annotations.json`,
    '.server-port',
    `${slug}.clips/a.png`,
    `${slug}.previous.json`,
    '..%2Fx',
  ])
    expect((await fetch(`${content}/c/${path}`)).status).toBe(404);
  // A write from the artifact's origin is refused, as a forged review would be.
  const forged = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/feedback`,
      { method: 'POST', headers: { origin: content, 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ slug }));
  });
  expect(forged).toBe(403);
});

it('stores a screenshot per saved comment, names it in the feedback, and prunes it with the comment', async () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const lib = await fetch(`${base.replace('127.0.0.1', 'localhost')}/_artifacts/modern-screenshot.mjs`);
  expect(lib.status).toBe(200);
  expect(await lib.text()).toContain('domToCanvas');
  // Only a saved comment, a filename-safe id, and real PNG bytes are accepted.
  expect((await request('/api/clips', { slug, id: 'pin', png })).status).toBe(400);
  const list = [annotation('pin', { element: { selector: '#chart', label: 'Chart' } }), annotation('plain')];
  expect((await request('/api/annotations', { slug, annotations: list }, 'PUT')).status).toBe(200);
  expect((await request('/api/clips', { slug, id: '../pin', png })).status).toBe(400);
  expect((await request('/api/clips', { slug, id: 'pin', png: 'data:image/png;base64,aGVsbG8=' })).status).toBe(400);
  expect((await request('/api/clips', { slug, id: 'pin', png })).status).toBe(200);
  const clip = join(process.cwd(), '.pi', 'artifacts', `${slug}.clips`, 'pin.png');
  expect(readFileSync(clip).subarray(1, 4).toString()).toBe('PNG');

  let message = '';
  setFeedbackSender((text) => ((message = text), true));
  expect((await request('/api/feedback', { slug })).status).toBe(200);
  expect(message).toContain(`[annotationId: pin]\n   Screenshot: ${clip}`);
  expect(message.match(/Screenshot: /g)).toHaveLength(1);
  expect(message).toContain('as the reviewer saw it');

  // Sent records keep their screenshots; a comment that leaves the sidecar takes its file along.
  expect((await request('/api/annotations', { slug, annotations: [] }, 'PUT')).status).toBe(200);
  expect(existsSync(clip)).toBe(true);
  writeAnnotations(
    slug,
    readAnnotations(slug).filter((a) => a.id !== 'pin'),
  );
  expect(existsSync(clip)).toBe(false);
});

it('rejects invalid data and stale writes, strips rendering caches, and cannot forge sent records', async () => {
  const first = annotationState(slug).revision;
  expect(
    (
      await request(
        '/api/annotations',
        { slug, annotations: [annotation('a', { intent: 'question' })], revision: first },
        'PUT',
      )
    ).status,
  ).toBe(200);
  expect((await request('/api/annotations', { slug, annotations: [], revision: first }, 'PUT')).status).toBe(409);
  expect((await request('/api/feedback', { slug, revision: first })).status).toBe(409);
  expect((await request('/api/annotations', { slug, annotations: [{ id: 'bad', quote: null }] }, 'PUT')).status).toBe(
    400,
  );
  expect((await request('/api/annotations', null, 'PUT')).status).toBe(400);
  const poisoned = {
    ...annotation('poison'),
    sentAt: 'forged',
    reply: 'forged',
    _html: '<img src=x onerror=alert(1)>',
  };
  expect((await request('/api/annotations', { slug, annotations: [poisoned] }, 'PUT')).status).toBe(200);
  expect(readAnnotations(slug)).toEqual([annotation('poison', { createdAt: poisoned.createdAt })]);
  writeFileSync(annotationsPath(slug), JSON.stringify({ version: 1, annotations: [poisoned] }));
  expect(readAnnotations(slug)[0]).not.toHaveProperty('_html');
  const response = await fetch(`${base}/api/annotations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' },
    body: JSON.stringify({ slug, annotations: [] }),
  });
  expect(response.status).toBe(403);
});

it('leaves drafts intact if the sender throws and refuses to overwrite corrupt saved feedback', async () => {
  writeAnnotations(slug, [annotation('a')]);
  setFeedbackSender(() => {
    throw new Error('offline');
  });
  expect((await request('/api/feedback', { slug })).status).toBe(503);
  expect(readAnnotations(slug)[0]?.sentAt).toBeUndefined();
  writeFileSync(annotationsPath(slug), 'broken');
  expect((await request('/api/annotations', { slug, annotations: [] }, 'PUT')).status).toBe(500);
  expect(readFileSync(annotationsPath(slug), 'utf8')).toBe('broken');
});

it('matches duplicate quotes using normalized surrounding context', () => {
  const text = 'Repeat. Middle. Repeat. End.';
  expect(isStale(annotation('a', { quote: { exact: 'Repeat.', prefix: 'Middle.', suffix: 'End.' } }), text)).toBe(
    false,
  );
  expect(isStale(annotation('a', { quote: { exact: 'Repeat.', prefix: 'Missing' } }), text)).toBe(true);
  expect(isStale(annotation('general'), text)).toBe(false);
});

it('does not execute comment HTML or unsafe markdown links', () => {
  const html = renderCommentMarkdown('**bold** <img src=x onerror=alert(1)> [bad](javascript:alert%281%29)');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('href="javascript:');
});

it('compares evidence changes even when the markdown source stayed the same', () => {
  const html = readFileSync(artifactPath(slug), 'utf8');
  writeArtifact(slug, renderReviewContent(html, [], [{ id: 'proof', title: 'Proof', quote: 'old proof' }]));
  savePreviousRevision(slug);
  writeArtifact(slug, renderReviewContent(html, [], [{ id: 'proof', title: 'Proof', quote: 'new proof' }]));
  const comparison = renderRevisionComparison(slug)!;
  expect(comparison).toContain('HTML source');
  expect(comparison).toContain('old proof');
  expect(comparison).toContain('new proof');
  expect(comparison).toContain('<mark>');
});
