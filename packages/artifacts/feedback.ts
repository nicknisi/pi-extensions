/**
 * Annotation state on disk + composed agent message. No pi imports — pure node,
 * so `smoke.mjs` can drive it directly against `dist/`.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { annotationsPath, isSafeSlug, readArtifact, sourcePath } from './utils.js';
import { injectAnnotations } from './annotate.js';

export interface TextQuoteAnchor {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface Annotation {
  id: string;
  quote: TextQuoteAnchor;
  comment: string;
  createdAt: string;
}

interface Sidecar {
  version: 1;
  annotations: Annotation[];
}

/** Collapse all whitespace runs to a single space and trim. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Read the annotation list for a slug; [] when missing, corrupt, or slug is unsafe. */
export function readAnnotations(slug: string): Annotation[] {
  if (!isSafeSlug(slug)) return [];
  const path = annotationsPath(slug);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Sidecar>;
    return Array.isArray(parsed.annotations) ? parsed.annotations : [];
  } catch {
    return [];
  }
}

/** Replace the annotation list for a slug. Throws (surfaced as 500) on write failure. */
export function writeAnnotations(slug: string, list: Annotation[]): void {
  if (!isSafeSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  const sidecar: Sidecar = { version: 1, annotations: list };
  writeFileSync(annotationsPath(slug), JSON.stringify(sidecar, null, 2), 'utf-8');
}

/** Remove the sidecar for a slug (on successful delivery). No-op if absent. */
export function deleteAnnotations(slug: string): void {
  if (!isSafeSlug(slug)) return;
  rmSync(annotationsPath(slug), { force: true });
}

/**
 * Inline tags: stripped with NO separator, so a quote spanning `<strong>x</strong>,`
 * still matches ("x," not "x ,"). Every other tag is a block boundary → a space.
 * br/hr are separators, not inline. Mirrors the client seam rule in annotate.ts.
 */
const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'wbr',
]);

/**
 * Whitespace-normalized visible text of the current artifact, for anchoring
 * checks. Strips comments/doctype/script/style and all tags, decodes the 5 basic
 * entities. Naive by design — this checks quote presence, not structure.
 */
export function artifactText(slug: string): string | null {
  const html = readArtifact(slug);
  if (html == null) return null;
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!doctype[^>]*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_m, tag: string) =>
      INLINE_TAGS.has(tag.toLowerCase()) ? '' : ' ',
    );
  const decoded = stripped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return normalize(decoded);
}

/**
 * Stale = the quote is not findable in the current artifact text. When `exact`
 * occurs more than once, prefix/suffix (when provided) must match around at
 * least one occurrence for the anchor to count as found.
 */
export function isStale(ann: Annotation, text: string): boolean {
  return !findAnchor(ann.quote, text);
}

/** True if the anchor resolves somewhere in the normalized text. */
function findAnchor(quote: TextQuoteAnchor, text: string): boolean {
  const exact = normalize(quote.exact);
  if (!exact) return false;

  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(exact, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + 1;
  }
  if (hits.length === 0) return false;

  const prefix = quote.prefix ? normalize(quote.prefix) : '';
  const suffix = quote.suffix ? normalize(quote.suffix) : '';
  // Context is captured from a live DOM and is best-effort: it disambiguates
  // duplicate quotes, but a unique occurrence stands on its own — a context
  // mismatch there says the capture was noisy, not that the passage is gone.
  if (hits.length === 1 || (!prefix && !suffix)) return true;

  return hits.some((idx) => {
    const before = text.slice(0, idx);
    const after = text.slice(idx + exact.length);
    return (!prefix || before.endsWith(prefix)) && (!suffix || after.startsWith(suffix));
  });
}

/**
 * Baked share render: the artifact with its annotations embedded and the layer
 * in static (read-only) mode. Null when there's nothing to bake — callers fall
 * back to the clean stored file.
 */
export function bakeAnnotations(slug: string): { html: string; count: number } | null {
  const anns = readAnnotations(slug);
  if (anns.length === 0) return null;
  const html = readArtifact(slug);
  if (html == null) return null;
  return { html: injectAnnotations(html, slug, JSON.stringify(anns), { static: true }), count: anns.length };
}

/**
 * 1-based line of the quote in <slug>.md, or undefined (no mirror / not found).
 * Plain normalized substring search; quotes crossing markdown formatting (**)
 * simply return undefined and the ref is omitted.
 */
export function sourceLine(ann: Annotation, slug: string): number | undefined {
  const path = sourcePath(slug);
  if (!existsSync(path)) return undefined;
  let source: string;
  try {
    source = readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
  const exact = normalize(ann.quote.exact);
  if (!exact) return undefined;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i]!).includes(exact)) return i + 1;
  }
  return undefined;
}

/**
 * Compose the markdown feedback message from the sidecar annotations plus the
 * server-computed stale flags and source-line refs.
 */
export function composeFeedback(
  slug: string,
  url: string,
  anns: Annotation[],
  staleFlags: boolean[],
  lines: (number | undefined)[],
): string {
  const parts: string[] = ['# Artifact Annotations', '', `Artifact: ${slug} (${url})`, ''];

  anns.forEach((ann, i) => {
    const stale = staleFlags[i] ? '[stale] ' : '';
    const line = lines[i];
    const lineRef = line !== undefined ? ` (source line ${line})` : '';
    parts.push(`${i + 1}. ${stale}> "${ann.quote.exact}"${lineRef}`);
    parts.push('');
    parts.push(`   ${ann.comment}`);
    parts.push('');
  });

  const staleCount = staleFlags.filter(Boolean).length;
  parts.push(`(${anns.length} comments · ${staleCount} stale)`);

  return parts.join('\n');
}
