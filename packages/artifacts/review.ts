/** Review sections and single-revision comparisons for artifact documents. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BASE_CSS } from './styles.js';
import { artifactDir, artifactPath, isSafeSlug, sourcePath } from './utils.js';

export interface ReviewDecision {
  id: string;
  question: string;
  options: { value: string; label: string }[];
  multiple?: boolean;
}

export interface ReviewEvidence {
  id: string;
  title: string;
  url?: string;
  source?: string;
  quote?: string;
}

interface RevisionSnapshot {
  html: string;
  source?: string;
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const MAX_ITEMS = 50;
const MAX_TEXT = 4_000;
const MAX_HTML = 5_000_000;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function assertText(value: string, name: string, allowEmpty = false): void {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > MAX_TEXT) {
    throw new Error(`invalid review ${name}`);
  }
}

function assertId(id: string, kind: string): void {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`invalid ${kind} id`);
}

function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function validateReview(decisions: ReviewDecision[], evidence: ReviewEvidence[]): void {
  if (
    !Array.isArray(decisions) ||
    !Array.isArray(evidence) ||
    decisions.length > MAX_ITEMS ||
    evidence.length > MAX_ITEMS
  ) {
    throw new Error('too many review items');
  }
  const decisionIds = new Set<string>();
  for (const decision of decisions) {
    assertId(decision.id, 'decision');
    if (decisionIds.has(decision.id)) throw new Error('duplicate decision id');
    decisionIds.add(decision.id);
    assertText(decision.question, 'question');
    if (!Array.isArray(decision.options) || decision.options.length < 2 || decision.options.length > MAX_ITEMS) {
      throw new Error('a decision needs at least two choices');
    }
    const values = new Set<string>();
    for (const option of decision.options) {
      assertText(option.value, 'choice value');
      assertText(option.label, 'choice label');
      if (values.has(option.value)) throw new Error('duplicate choice value');
      values.add(option.value);
    }
  }
  const evidenceIds = new Set<string>();
  for (const item of evidence) {
    assertId(item.id, 'evidence');
    if (evidenceIds.has(item.id)) throw new Error('duplicate evidence id');
    evidenceIds.add(item.id);
    assertText(item.title, 'evidence title');
    if (!item.source && !item.quote && !item.url) throw new Error('evidence needs source, quote, or url');
    if (item.source != null) assertText(item.source, 'evidence source');
    if (item.quote != null) assertText(item.quote, 'evidence quote');
    if (item.url != null && (typeof item.url !== 'string' || item.url.length > MAX_TEXT || !safeUrl(item.url))) {
      throw new Error('evidence URL must use http or https');
    }
  }
}

/** Add native decision and evidence controls without modifying the supplied content. */
export function renderReviewContent(html: string, decisions: ReviewDecision[], evidence: ReviewEvidence[]): string {
  if (typeof html !== 'string' || html.length > MAX_HTML) throw new Error('invalid artifact html');
  validateReview(decisions, evidence);
  if (!decisions.length && !evidence.length) return html;

  const decisionMarkup = decisions.length
    ? `<section class="artifact-review" data-artifact-review="decisions"><h2>Decisions</h2>${decisions
        .map((decision) => {
          const type = decision.multiple ? 'checkbox' : 'radio';
          const name = `artifact-decision-${decision.id}`;
          return `<fieldset data-artifact-decision="${decision.id}"><legend>${escapeHtml(decision.question)}</legend>${decision.options.map((option) => `<label><input type="${type}" name="${name}" value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</label>`).join('')}</fieldset>`;
        })
        .join('')}</section>`
    : '';
  const evidenceMarkup = evidence.length
    ? `<section class="artifact-review" data-artifact-review="evidence"><h2>Evidence</h2>${evidence
        .map((item) => {
          const url = item.url ? safeUrl(item.url)! : null;
          return `<details id="artifact-evidence-${item.id}" data-artifact-evidence="${item.id}"><summary>${escapeHtml(item.title)}</summary>${item.source ? `<p>${escapeHtml(item.source)}</p>` : ''}${item.quote ? `<blockquote><pre>${escapeHtml(item.quote)}</pre></blockquote>` : ''}${url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : ''}</details>`;
        })
        .join('')}</section>`
    : '';
  const style = `<style data-artifact-review>
.artifact-review{margin:2.5rem 0;color:inherit;font:inherit}
.artifact-review h2{margin-top:0}
.artifact-review fieldset{min-width:0;margin:1.25rem 0;padding:1rem;border:1px solid var(--border,currentColor);border-radius:12px}
.artifact-review legend{padding:0 .4rem;font-weight:600}
.artifact-review label{display:flex;gap:.7rem;align-items:baseline;padding:.7rem .8rem;margin:.25rem 0;border-radius:7px;cursor:pointer}
.artifact-review label:hover,.artifact-review label:has(input:checked){background:var(--code-bg,color-mix(in srgb,currentColor 6%,transparent))}
.artifact-review label:has(input:focus-visible){outline:2px solid var(--accent,currentColor);outline-offset:2px}
.artifact-review input{flex:none;margin:0;accent-color:var(--accent,auto)}
.artifact-review details{margin:.75rem 0;border:1px solid var(--border,currentColor);border-radius:10px;padding:1rem 1.25rem}
.artifact-review details:target{outline:2px solid var(--accent,currentColor);outline-offset:3px}
.artifact-review summary{cursor:pointer;font-weight:600}
.artifact-review blockquote{margin:.75rem 0;border-left:3px solid var(--accent,currentColor);padding-left:.75rem}
.artifact-review pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>`;
  const revealEvidence = evidence.length
    ? `<script>(function(){function reveal(){var id;try{id=decodeURIComponent(location.hash.slice(1));}catch(_){return;}var el=document.getElementById(id);if(el&&el.matches('details[data-artifact-evidence]'))el.open=true;}window.addEventListener('hashchange',reveal);document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href^="#artifact-evidence-"]');if(a)setTimeout(reveal,0);});reveal();})();</script>`
    : '';
  const addition = `${style}${decisionMarkup}${evidenceMarkup}${revealEvidence}`;
  const footer = html.search(/<footer\b[^>]*\bclass=(['"])\s*[^'"]*\bartifact-footer\b[^'"]*\1[^>]*>/i);
  const body = html.search(/<\/body\s*>/i);
  const at = footer >= 0 ? footer : body >= 0 ? body : html.length;
  return html.slice(0, at) + addition + html.slice(at);
}

function previousPath(slug: string): string {
  return join(artifactDir(), `${slug}.previous.json`);
}

/** Save the current artifact and its optional markdown source as the sole previous revision. */
export function savePreviousRevision(slug: string): void {
  if (!isSafeSlug(slug)) throw new Error('unsafe artifact slug');
  const htmlPath = artifactPath(slug);
  if (!existsSync(htmlPath)) return;
  const snapshot: RevisionSnapshot = { html: readFileSync(htmlPath, 'utf-8') };
  const markdownPath = sourcePath(slug);
  if (existsSync(markdownPath)) snapshot.source = readFileSync(markdownPath, 'utf-8');
  writeFileSync(previousPath(slug), JSON.stringify(snapshot), 'utf-8');
}

function readRevision(slug: string): RevisionSnapshot | null {
  if (!isSafeSlug(slug)) throw new Error('unsafe artifact slug');
  const path = previousPath(slug);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!value || typeof value !== 'object' || typeof (value as RevisionSnapshot).html !== 'string') return null;
    const snapshot = value as RevisionSnapshot;
    return typeof snapshot.source === 'string' ? snapshot : { html: snapshot.html };
  } catch {
    return null;
  }
}

function markedLines(text: string, prefix: number, suffix: number): string {
  const lines = text.split('\n');
  const changedEnd = Math.max(prefix, lines.length - suffix);
  return lines
    .map((line, index) =>
      index >= prefix && index < changedEnd ? `<mark>${escapeHtml(line)}</mark>` : escapeHtml(line),
    )
    .join('\n');
}

/** Remove active features. The iframe sandbox and CSP are the security boundary. */
function staticSnapshot(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?\s*>/gi, '')
    .replace(/<meta\b[^>]*\/?\s*>/gi, '')
    .replace(/<base\b[^>]*\/?\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<iframe\b[^>]*\/?\s*>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<(input|select|textarea|button|fieldset)\b/gi, '<$1 disabled')
    .replace(/<a\b[^>]*>/gi, (tag) => tag.replace(/\s(?:href|tabindex)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''));
}

/** Preserve readable text and document attributes without running scripts or loading remote assets. */
function previewDocument(html: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>${BASE_CSS}\nbody{min-height:100%}form,button,input,select,textarea{pointer-events:none}</style></head><body>${staticSnapshot(html)}</body></html>`;
}

function artifactTitle(html: string, slug: string): string {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  return title ? title.replace(/<[^>]*>/g, '').trim() || slug : slug;
}

/** Render a safe, static comparison between the saved revision and the current artifact. */
export function renderRevisionComparison(slug: string): string | null {
  if (!isSafeSlug(slug)) throw new Error('unsafe artifact slug');
  const previous = readRevision(slug);
  const currentHtmlPath = artifactPath(slug);
  if (!previous || !existsSync(currentHtmlPath)) return null;
  const currentHtml = readFileSync(currentHtmlPath, 'utf-8');
  const currentSourcePath = sourcePath(slug);
  const currentSource = existsSync(currentSourcePath) ? readFileSync(currentSourcePath, 'utf-8') : undefined;
  const reviewSections = (html: string) =>
    (html.match(/<section class="artifact-review"[\s\S]*?<\/section>/g) ?? []).join('\n');
  const useSource =
    previous.source !== undefined &&
    currentSource !== undefined &&
    reviewSections(previous.html) === reviewSections(currentHtml);
  const oldText = useSource ? previous.source! : previous.html;
  const newText = useSource ? currentSource! : currentHtml;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // ponytail: mark the changed middle in O(n), use a line-diff library if granular hunks become necessary.
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  const safeSlug = escapeHtml(slug);
  const title = escapeHtml(artifactTitle(currentHtml, slug));
  const sourceLabel = useSource ? 'Markdown source' : 'HTML source';
  const previousPreview = escapeHtml(previewDocument(previous.html));
  const currentPreview = escapeHtml(previewDocument(currentHtml));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Changes</title><style data-base>${BASE_CSS}</style><style>body>article{max-width:1480px}.comparison-header{margin-bottom:1.5rem}.comparison-header h1{margin-bottom:.25rem}.comparison-subtitle{color:var(--muted);margin:0}.comparison-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.comparison-panel{min-width:0}.comparison-panel h2{margin-top:0}.static-note{color:var(--muted);font-size:.82rem;margin:-.45rem 0 .6rem}.snapshot{display:block;width:100%;height:min(65vh,48rem);min-height:28rem;border:1px solid var(--border);border-radius:8px;background:var(--code-bg)}.source-changes{margin-top:2rem}.source-changes summary{cursor:pointer;font-weight:600}.source-changes p{color:var(--muted);font-size:.85rem}.source-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.source-grid pre{height:min(50vh,32rem);margin:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.source-grid mark{background:var(--add-word-bg);color:inherit}@media(max-width:700px){.comparison-grid,.source-grid{grid-template-columns:1fr}.snapshot{height:55vh;min-height:22rem}}</style></head><body><article><p><a href="/${safeSlug}.html">Back to artifact</a></p><header class="comparison-header"><h1>Changes</h1><p class="comparison-subtitle">${title}</p></header><div class="comparison-grid"><section class="comparison-panel"><h2>Previous</h2><p class="static-note">Static, noninteractive preview</p><iframe class="snapshot" title="Previous artifact preview" sandbox="" referrerpolicy="no-referrer" srcdoc="${previousPreview}"></iframe></section><section class="comparison-panel"><h2>Current</h2><p class="static-note">Static, noninteractive preview</p><iframe class="snapshot" title="Current artifact preview" sandbox="" referrerpolicy="no-referrer" srcdoc="${currentPreview}"></iframe></section></div><details class="source-changes"><summary>Source changes</summary><p>${sourceLabel}. Highlighted lines are the changed region.</p><div class="source-grid"><section><h2>Previous</h2><pre>${markedLines(oldText, prefix, suffix)}</pre></section><section><h2>Current</h2><pre>${markedLines(newText, prefix, suffix)}</pre></section></div></details></article></body></html>`;
}
