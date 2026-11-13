/** HTML shell + markdown→HTML rendering with server-side diff, code and mermaid (Pele) rendering. */

import { Marked } from 'marked';
import { parse as diffParse, html as diffHtml } from 'diff2html';
import hljs from 'highlight.js';
import { render as renderDiagram } from 'pele';

import { EVENT_HUB_JS } from './events.js';
import { BASE_CSS, D2H_CSS, HLJS_CSS } from './styles.js';
import { READER_FONT, readerBody, READER_ATTRIBUTES, READER_SCRIPT, READER_STYLES } from './reader.js';

export interface RenderFlags {
  hasDiff: boolean;
  hasCode: boolean;
}

/** Escape HTML special characters. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for attribute context (quotes too). */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** Render markdown to an HTML body fragment, handling diff/code/mermaid fences. */
export function renderMarkdown(content: string, flags: RenderFlags): string {
  // Fresh instance per render: the code renderer closes over `flags`, and mutating
  // the global marked singleton would stack an override per call.
  let diagrams = 0;
  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }: { text: string; lang?: string }): string {
        const language = (lang ?? '').trim().toLowerCase();

        if (language === 'mermaid') {
          const rendered = renderMermaid(text, `artifact-diagram-${++diagrams}-`);
          if (rendered) return `<div class="artifact-mermaid">${rendered}</div>`;
          // Unsupported or malformed diagram — fall through to plain code block
        }

        if (language === 'diff') {
          const rendered = renderDiff(text);
          if (rendered) {
            flags.hasDiff = true;
            return rendered;
          }
          // Malformed diff — fall through to plain code block
        }

        const known = language && hljs.getLanguage(language);
        if (known) {
          flags.hasCode = true;
          try {
            const out = hljs.highlight(text, { language }).value;
            return `<pre><code class="hljs language-${escapeAttr(language)}">${out}</code></pre>`;
          } catch {
            // fall through
          }
        }

        // Plain escaped code block (no unreliable auto-detect on short snippets)
        if (language) flags.hasCode = true;
        return `<pre><code${language ? ` class="language-${escapeAttr(language)}"` : ''}>${escapeHtml(text)}</code></pre>`;
      },
    },
  });

  return marked.parse(content) as string;
}

/**
 * Render an annotation comment's markdown for display (popover preview, panel
 * items). Plain GFM with soft breaks — no diff/code/mermaid renderers, since the
 * page has no d2h/hljs stylesheets for this content. Strips script/iframe and
 * inline event handlers: the author is the local user, but a pasted snippet
 * should not execute in the artifact page.
 */
const commentMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      try {
        const url = new URL(href, 'http://artifact.invalid');
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return label;
      } catch {
        return label;
      }
      return `<a href="${escapeAttr(href)}" rel="noopener noreferrer">${label}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderCommentMarkdown(md: string): string {
  const html = commentMarked.parse(md) as string;
  return html;
}

/**
 * Render a mermaid diagram to SVG with Pele (server-side, no script). Colors come from
 * `--pele-*` CSS variables mapped onto the scheme tokens, so the reader's theme toggle
 * restyles it without re-rendering. Returns null when Pele can't render it.
 */
function renderMermaid(source: string, idPrefix: string): string | null {
  try {
    return renderDiagram(source, { idPrefix, fontFamily: READER_FONT }).svg;
  } catch {
    return null;
  }
}

/** Render a unified-diff string to diff2html HTML (server-side). Returns null if parse yields nothing. */
function renderDiff(diffText: string): string | null {
  try {
    const json = diffParse(diffText, {});
    if (!json || json.length === 0) return null;
    return diffHtml(json, {
      outputFormat: 'line-by-line',
      drawFileList: false,
    });
  } catch {
    return null;
  }
}

// ─── Shell ────────────────────────────────────────────────────────────────────

/** SSE snippet: reload only on events for this slug, over the page's shared stream. */
export function sseSnippet(slug: string): string {
  return `
<script data-artifact-reload>
${EVENT_HUB_JS}
(function () {
  var slug = ${JSON.stringify(slug)};
  if (!window.__artifactEvents) return;
  window.__artifactEvents.on(slug, "reload", function (e) {
    try { if ((e.data === slug || e.data === "*") && window.dispatchEvent(new Event("artifact:before-reload", { cancelable: true }))) location.reload(); } catch (_) {}
  });
})();
</script>`;
}

/** Build the full HTML document shell around a body fragment. */
export function buildShell(opts: {
  title: string;
  slug: string;
  kind: 'markdown' | 'html';
  bodyHtml: string;
  flags: RenderFlags;
}): string {
  const { title, slug, kind, bodyHtml, flags } = opts;
  const projectPath = process.cwd();
  const generated = Date.now();

  const styles: string[] = [`<style data-base>${BASE_CSS}</style>`];
  if (kind === 'markdown') styles.push(READER_STYLES);
  if (flags.hasDiff) styles.push(`<style data-d2h>${D2H_CSS}</style>`);
  if (flags.hasCode) styles.push(`<style data-hljs>${HLJS_CSS}</style>`);

  const scripts: string[] = kind === 'markdown' ? [READER_SCRIPT] : [];
  scripts.push(sseSnippet(slug));

  const generatedIso = new Date(generated).toISOString();
  const body =
    kind === 'markdown'
      ? readerBody(title, bodyHtml, generatedIso, projectPath)
      : `<article>
<header class="artifact-header">
<h1>${escapeHtml(title)}</h1>
<span class="artifact-badge">${kind}</span>
<span class="artifact-meta">${escapeHtml(generatedIso.replace('T', ' ').slice(0, 19))}</span>
</header>
${bodyHtml}
<footer class="artifact-footer">source: ${escapeHtml(projectPath)}</footer>
</article>`;

  return `<!DOCTYPE html>
<html lang="en"${kind === 'markdown' ? ' ' + READER_ATTRIBUTES : ''}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="artifact-kind" content="${kind}">
<meta name="artifact-generated" content="${generated}">
<meta name="artifact-project" content="${escapeAttr(projectPath)}">
<title>${escapeHtml(title)}</title>
${styles.join('\n')}
</head>
<body>
${body}
${scripts.join('\n')}
</body>
</html>`;
}

/** Render a markdown artifact to a full HTML document. */
export function renderMarkdownDocument(title: string, slug: string, content: string): string {
  const flags: RenderFlags = { hasDiff: false, hasCode: false };
  const bodyHtml = renderMarkdown(content, flags);
  return buildShell({ title, slug, kind: 'markdown', bodyHtml, flags });
}

/** Render an html artifact: full documents get the shell's metadata metas + SSE reload snippet spliced in; fragments get the full shell. */
export function renderHtmlDocument(title: string, slug: string, content: string): string {
  const trimmed = content.trimStart();
  const isFullDoc = /^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
  if (isFullDoc) {
    // Full documents bypass the shell, so inject the same metadata metas the shell
    // writes (artifact-kind/generated/project) plus the SSE reload listener. Both
    // are passive — they change no rendering — but they keep full-doc html consistent
    // on the index page (date + kind badge) and let `update` live-reload like any
    // other artifact. Skip any meta the document already declares to avoid dupes.
    const generated = Date.now();
    const projectPath = process.cwd();
    const metas: string[] = [];
    if (!content.includes('name="artifact-kind"')) metas.push(`<meta name="artifact-kind" content="html">`);
    if (!content.includes('name="artifact-generated"'))
      metas.push(`<meta name="artifact-generated" content="${generated}">`);
    if (!content.includes('name="artifact-project"'))
      metas.push(`<meta name="artifact-project" content="${escapeAttr(projectPath)}">`);
    const metaBlock = metas.length ? metas.join('\n') + '\n' : '';
    const snippet = sseSnippet(slug);

    let out = content;
    // Metas belong in <head>; splice there when present.
    const headClose = out.search(/<\/head>/i);
    if (headClose !== -1 && metaBlock) {
      out = out.slice(0, headClose) + metaBlock + out.slice(headClose);
    }
    // SSE listener before </body>. If there was no <head>, also drop the metas here —
    // the index parser is regex-based, so location is irrelevant to function.
    const tail = (headClose === -1 ? metaBlock : '') + snippet;
    const bodyClose = out.search(/<\/body>/i);
    out = bodyClose !== -1 ? out.slice(0, bodyClose) + tail + out.slice(bodyClose) : out + tail;
    return out;
  }

  const flags: RenderFlags = { hasDiff: false, hasCode: false };
  return buildShell({ title, slug, kind: 'html', bodyHtml: content, flags });
}

/** Build the index page listing all artifacts, newest first. */
export function renderIndexPage(entries: { slug: string; title: string; kind: string; mtime: number }[]): string {
  const projectPath = process.cwd();
  const rows = entries.map((e) => {
    const when = e.mtime ? new Date(e.mtime).toISOString().replace('T', ' ').slice(0, 19) : '';
    const href = `/${e.slug}.html`;
    return (
      `<tr><td><a href="${escapeAttr(href)}">${escapeHtml(e.title)}</a></td>` +
      `<td><span class="artifact-badge">${escapeHtml(e.kind)}</span></td>` +
      `<td><code>${escapeHtml(when)}</code></td></tr>`
    );
  });

  const empty =
    entries.length === 0
      ? `<p><em>No artifacts yet. Use the <code>artifact</code> tool to create one.</em></p>`
      : `<table><thead><tr><th>Title</th><th>Kind</th><th>Generated</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>`;

  const styles = [`<style data-base>${BASE_CSS}</style>`];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="artifact-kind" content="html">
<title>Artifacts — ${escapeHtml(projectPath)}</title>
${styles.join('\n')}
</head>
<body>
<article>
<header class="artifact-header">
<h1>Artifacts</h1>
<span class="artifact-badge">index</span>
</header>
${empty}
<footer class="artifact-footer">source: ${escapeHtml(projectPath)}</footer>
</article>
</body>
</html>`;
}
