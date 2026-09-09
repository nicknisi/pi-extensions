import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  expect(shared.html).toContain('STATIC = true');
  expect(shared.html).not.toContain('<script data-artifact-reload>');
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
