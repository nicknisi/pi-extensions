/** Tiny optional service provider over the existing artifact runtime. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { rmSync } from 'node:fs';
import { ARTIFACTS_SERVICE, type ArtifactsAPI } from './contract.js';
import { answerQuestion } from './feedback.js';
import { savePreviousRevision } from './review.js';
import { artifactUrl, notifyAnnotations, notifyReload, setFeedbackSender, type FeedbackSender } from './server.js';
import { renderHtmlDocument } from './templates.js';
import { artifactExists, isSafeSlug, openInBrowser, slugify, sourcePath, writeArtifact } from './utils.js';

export function provideArtifacts(events: Pick<ExtensionAPI['events'], 'on'>, fallback: FeedbackSender) {
  const cwd = process.cwd();
  let disposed = false;
  const cancelDeliveries = new Set<() => void>();
  const subscribers = new Map<string, { onFeedback: Parameters<ArtifactsAPI['subscribe']>[0]['onFeedback'] }>();
  const guard = () => {
    if (disposed || process.cwd() !== cwd) throw new Error('Artifacts service disposed or project changed');
  };
  const slugGuard = (slug: string) => {
    if (typeof slug !== 'string' || !isSafeSlug(slug)) throw new Error('invalid slug');
  };
  const api: ArtifactsAPI = Object.freeze({
    async publish({ title, html, open }) {
      guard();
      if (typeof title !== 'string' || !title.trim() || title.length > 4000) throw new Error('invalid title');
      if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024)
        throw new Error('HTML exceeds 2 MB or is invalid');
      if (open !== undefined && typeof open !== 'boolean') throw new Error('invalid open');
      const slug = slugify(title);
      slugGuard(slug);
      // Synchronous writes preserve invocation order. Callers own sequencing/coalescing.
      const rendered = renderHtmlDocument(title.trim(), slug, html);
      savePreviousRevision(slug);
      const absPath = writeArtifact(slug, rendered);
      rmSync(sourcePath(slug), { force: true });
      notifyReload(slug);
      const url = await artifactUrl(slug);
      guard();
      if (open === true) openInBrowser(url);
      return { slug, url, absPath };
    },
    async answer({ slug, annotationId, content }) {
      guard();
      slugGuard(slug);
      if (!artifactExists(slug)) throw new Error('no such artifact');
      if (typeof annotationId !== 'string' || !annotationId || typeof content !== 'string')
        throw new Error('invalid answer');
      answerQuestion(slug, annotationId, content);
      notifyAnnotations(slug);
      return { ok: true as const };
    },
    async subscribe({ slug, onFeedback }) {
      guard();
      slugGuard(slug);
      if (typeof onFeedback !== 'function') throw new Error('invalid onFeedback');
      if (subscribers.has(slug)) throw new Error(`Artifact ${slug} already has a subscriber`);
      const owner = { onFeedback };
      subscribers.set(slug, owner);
      return () => {
        if (subscribers.get(slug) === owner) subscribers.delete(slug);
      };
    },
  } satisfies ArtifactsAPI);
  const sender: FeedbackSender = async (markdown, metadata) => {
    guard();
    const owner = subscribers.get(metadata.slug);
    // Capture one owner. A rejection/false/disposal must never reroute this batch.
    let cancel!: () => void;
    const cancelled = new Promise<false>((resolve) => {
      cancel = () => resolve(false);
    });
    cancelDeliveries.add(cancel);
    try {
      const delivered = await Promise.race([
        owner
          ? owner.onFeedback({ markdown, slug: metadata.slug, annotationIds: [...metadata.annotationIds] })
          : fallback(markdown, metadata),
        cancelled,
      ]);
      guard();
      return delivered === true;
    } finally {
      cancelDeliveries.delete(cancel);
    }
  };
  const releaseSender = setFeedbackSender(sender);
  const off = events.on(ARTIFACTS_SERVICE.discoveryEvent, (request: unknown) => {
    if (disposed || !request || typeof request !== 'object') return;
    const { id, apiMajor, offer } = request as { id?: unknown; apiMajor?: unknown; offer?: unknown };
    if (id !== undefined && id !== ARTIFACTS_SERVICE.id) return;
    if (apiMajor !== undefined && apiMajor !== ARTIFACTS_SERVICE.apiMajor) return;
    if (typeof offer === 'function') offer({ id: ARTIFACTS_SERVICE.id, apiMajor: ARTIFACTS_SERVICE.apiMajor, api });
  });
  return {
    api,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of cancelDeliveries) cancel();
      cancelDeliveries.clear();
      off();
      subscribers.clear();
      releaseSender();
    },
  };
}
