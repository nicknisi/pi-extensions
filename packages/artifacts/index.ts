/** Artifacts extension — registers the `artifact` tool (create/update/open/list) and a TUI result card. */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { hyperlink } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { shareBaked } from './feedback.js';

import { artifactUrl, isRunning, notifyReload, runningPort, setFeedbackSender, stopServer } from './server.js';
import type { FeedbackSender } from './server.js';
import {
  slugify,
  isSafeSlug,
  writeArtifact,
  writeSourceMirror,
  artifactExists,
  listArtifacts,
  openInBrowser,
  artifactPath,
  revealFile,
} from './utils.js';
import { renderMarkdownDocument, renderHtmlDocument } from './templates.js';

interface ArtifactDetails {
  action: string;
  slug: string;
  title: string;
  kind: 'markdown' | 'html';
  url?: string | undefined;
  absPath: string;
}

function errResult(message: string, details: Partial<ArtifactDetails> = {}) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
    details: { ...details } as Record<string, unknown>,
  };
}

/** Resolve content from inline `content` or `path` (file read, with a size cap). */
function resolveContent(params: { content?: string; path?: string }): { content: string } | { error: string } {
  if (params.content != null) return { content: params.content };
  if (params.path) {
    const abs = join(process.cwd(), params.path);
    try {
      const size = statSync(abs).size;
      const MAX = 2 * 1024 * 1024; // 2 MB — a stray path at a big log becomes a sad browser tab
      if (size > MAX) {
        return {
          error: `file is ${Math.round(size / 1024 / 1024)} MB — exceeds the 2 MB limit. Excerpt the relevant portion into \`content\` instead of reading the whole file via \`path\`.`,
        };
      }
      return { content: readFileSync(abs, 'utf-8') };
    } catch {
      return { error: `could not read file at "${params.path}".` };
    }
  }
  return { error: 'provide `content` or `path` for create/update.' };
}

/** "5m ago" style label for the artifact picker. */
function ago(mtime: number): string {
  const s = Math.max(0, Math.floor((Date.now() - mtime) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Show the latest artifact as a persistent, clickable footer status. */
function setArtifactStatus(ctx: ExtensionContext, title: string, url: string | undefined) {
  if (!url) return;
  // \u{F0C5} =  copy — nerd-font glyph matching the statusline's icon convention
  ctx.ui.setStatus('artifacts', `\u{F0C5} ${hyperlink(ctx.ui.theme.fg('accent', title), url)}`);
}

export default function artifacts(pi: ExtensionAPI) {
  // Deliver composed feedback to the live session as a follow-up message.
  const sender: FeedbackSender = (markdown) => {
    pi.sendUserMessage(markdown, { deliverAs: 'followUp' });
    return true;
  };
  setFeedbackSender(sender); // factory time — first session
  pi.on('session_start', () => setFeedbackSender(sender)); // re-register across session replacement

  pi.on('session_shutdown', () => {
    setFeedbackSender(null);
    stopServer();
  });

  // ─── /artifacts command — pick an artifact to open (falls back to the index page) ──
  pi.registerCommand('artifacts', {
    description: 'Pick a generated artifact to open in the browser (starts the localhost server if not running)',
    handler: async (_args, ctx) => {
      const entries = listArtifacts();
      if (ctx.hasUI && entries.length > 0) {
        const labels = entries.map((e) => `${e.title}  (${e.kind}, ${ago(e.mtime)})`);
        const picked = await ctx.ui.select('Open artifact', labels);
        if (picked === undefined) return; // Esc — cancelled
        const entry = entries[labels.indexOf(picked)]!;
        const url = await artifactUrl(entry.slug);
        openInBrowser(url);
        setArtifactStatus(ctx, entry.title, url);
        return;
      }
      // No UI (print/RPC) or nothing to pick — open the index page.
      const url = await artifactUrl(); // no slug → index; ensureServer starts lazily
      openInBrowser(url);
      if (ctx.hasUI) ctx.ui.notify(`Artifacts: ${url}`, 'info');
    },
  });

  pi.registerTool({
    name: 'artifact',
    label: 'Artifact',
    description:
      'Create, update, open, or list HTML artifacts rendered from markdown or raw HTML and served from a lazy localhost server (opened in the browser). Two kinds: `markdown` (rendered to styled HTML — GFM tables, fenced ```diff blocks render as diffs, fenced code blocks get syntax highlighting, fenced ```mermaid blocks render as diagrams) and `html` (escape hatch — body fragment injected into a styled shell, or a full <!DOCTYPE> document passed through unchanged). `create`/`update` write the file and return the slug + localhost URL + absolute path; `update` on a slug whose file is missing creates it. `update` on an already-open artifact refreshes the browser tab in place via live reload. `open` starts the server and opens the artifact. `list` lists existing artifacts (does not start the server). Set `path` to read content from a file instead of passing `content` (kind is still required). html fragments inherit the artifact stylesheet (system fonts, light/dark scheme) and its CSS variables — `--bg`, `--fg`, `--muted`, `--border`, `--code-bg`, `--accent` — so write semantic HTML and use those variables in any scoped <style> instead of hardcoding colors. Storage: <project>/.pi/artifacts/<slug>.html.',
    promptSnippet:
      'Emit visual output (reports, diagrams, rendered diffs, tables) as a browser HTML artifact instead of terminal text',
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('create'),
          Type.Literal('update'),
          Type.Literal('open'),
          Type.Literal('list'),
          Type.Literal('share'),
        ],
        {
          description:
            'create: write new artifact. update: overwrite existing (or create if missing) + live-reload open tabs. open: start server + open in browser. list: list artifacts (no server start). share: hand the artifact file off — clipboard, file manager, or a GitHub gist (gist only when the user asks for an upload; it shows the source, not a rendered page). When the artifact has annotation comments, clipboard and gist bake them in (highlights + read-only panel) unless annotations: false.',
        },
      ),
      method: Type.Optional(
        Type.Union(
          [
            Type.Literal('clipboard'),
            Type.Literal('reveal'),
            Type.Literal('gist'),
            Type.Literal('image'),
            Type.Literal('pdf'),
          ],
          {
            description:
              "share only. clipboard (default): copy the self-contained HTML. reveal: show the file in the OS file manager. gist: `gh gist create` (requires gh CLI + auth) — uploads under the user's GitHub account, copies the URL, opens it. image: screenshot the rendered artifact to <slug>.png via a headless Chrome-family browser (copies the PNG to the clipboard on macOS). pdf: print the rendered artifact to <slug>.pdf (copies the file reference to the clipboard on macOS). image/pdf render with the comments panel/section visible when comments exist.",
          },
        ),
      ),
      width: Type.Optional(
        Type.Integer({ description: 'share method=image only. Viewport width in px. Default: 1280.', minimum: 200 }),
      ),
      height: Type.Optional(
        Type.Integer({ description: 'share method=image only. Viewport height in px. Default: 800.', minimum: 200 }),
      ),
      public: Type.Optional(
        Type.Boolean({ description: 'share method=gist only. Make the gist public. Default: false (secret gist).' }),
      ),
      annotations: Type.Optional(
        Type.Boolean({
          description:
            'share only. When the artifact has annotation comments, bake them into the shared file (highlights + read-only comments panel) for the clipboard and gist methods. Default: true.',
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: 'Artifact title; slug is derived from it. Required for create/update/open.',
        }),
      ),
      kind: Type.Optional(
        Type.Union([Type.Literal('markdown'), Type.Literal('html')], {
          description:
            'Required for create/update. markdown = rendered to styled HTML (diff/code/mermaid fences handled). html = passthrough.',
        }),
      ),
      content: Type.Optional(Type.String({ description: 'Inline content (markdown or HTML). Alternative to `path`.' })),
      path: Type.Optional(
        Type.String({
          description:
            'Read content from this file path (relative to cwd) instead of `content`. kind still required. File is rendered into .pi/artifacts/, not served in place.',
        }),
      ),
      open: Type.Optional(
        Type.Boolean({
          description:
            'Auto-open in browser after write. Default: true on create, false on update (use action: open to view an update).',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;

      // ── list ──────────────────────────────────────────────────────────────
      if (action === 'list') {
        const entries = listArtifacts();
        const port = runningPort();
        const lines = entries.map((e) => {
          const when = e.mtime ? new Date(e.mtime).toISOString().replace('T', ' ').slice(0, 19) : '';
          const url = port ? `http://127.0.0.1:${port}/${e.slug}.html` : '';
          return `- ${e.title} [${e.kind}] ${when}  ${e.slug}${url ? '  ' + url : ''}\n  ${e.absPath}`;
        });
        const text =
          entries.length === 0
            ? 'No artifacts in .pi/artifacts/ yet.'
            : `${entries.length} artifact(s):\n\n${lines.join('\n')}`;
        return {
          content: [{ type: 'text' as const, text }],
          details: { action, count: entries.length, serverRunning: port !== null } as Record<string, unknown>,
        };
      }

      // ── create / update / open — need title for slug ───────────────────────
      const title = params.title?.trim();
      if (!title) {
        return errResult('`title` is required for create/update/open.');
      }
      const slug = slugify(title);
      if (!isSafeSlug(slug)) {
        return errResult(`derived slug "${slug}" is invalid.`, { slug, title });
      }
      const kind = params.kind;
      const absPath = artifactPath(slug);

      // ── open ───────────────────────────────────────────────────────────────
      if (action === 'open') {
        if (!artifactExists(slug)) {
          return errResult(`no artifact with slug "${slug}" — create it first.`, { slug, title });
        }
        const url = await artifactUrl(slug);
        openInBrowser(url);
        setArtifactStatus(ctx, title, url);
        const details: ArtifactDetails = {
          action,
          slug,
          title,
          kind: kind ?? 'markdown',
          url,
          absPath,
        };
        return {
          content: [{ type: 'text' as const, text: `Opened ${title}\n${url}\n${absPath}` }],
          details: details as unknown as Record<string, unknown>,
        };
      }

      // ── share ──────────────────────────────────────────────────────────────
      if (action === 'share') {
        if (!artifactExists(slug)) {
          return errResult(`no artifact with slug "${slug}" — create it first.`, { slug, title });
        }
        const method = params.method ?? 'clipboard';
        const bake = params.annotations !== false;
        try {
          if (method === 'clipboard') {
            const res = await shareBaked(slug, title, 'copy', { bake });
            const note = res.count ? ` — ${res.count} comment${res.count === 1 ? '' : 's'} baked in` : '';
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Copied ${title} to the clipboard (${Math.round((res.bytes ?? 0) / 1024)} KB of self-contained HTML)${note}.\n${absPath}`,
                },
              ],
              details: { action, slug, title, method, absPath } as Record<string, unknown>,
            };
          }
          if (method === 'reveal') {
            revealFile(absPath);
            return {
              content: [{ type: 'text' as const, text: `Revealed in the file manager:\n${absPath}` }],
              details: { action, slug, title, method, absPath } as Record<string, unknown>,
            };
          }
          if (method === 'image' || method === 'pdf') {
            const baseUrl = new URL(await artifactUrl(slug)).origin; // starts the lazy server Chrome will hit
            const res = await shareBaked(slug, title, method, {
              baseUrl,
              bake,
              ...(params.width !== undefined ? { width: params.width } : {}),
              ...(params.height !== undefined ? { height: params.height } : {}),
            });
            const noun = method === 'image' ? 'an image' : 'a PDF';
            const note = res.count ? ` with ${res.count} comment${res.count === 1 ? '' : 's'} visible` : '';
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Rendered ${title} to ${noun}${note}:\n${res.path}${res.copied ? '\nCopied to the clipboard — paste it anywhere.' : ''}`,
                },
              ],
              details: { action, slug, title, method, absPath: res.path, copied: res.copied } as Record<
                string,
                unknown
              >,
            };
          }
          // gist
          const res = await shareBaked(slug, title, 'gist', { public: params.public ?? false, bake });
          const url = res.url!;
          const note = res.count ? ` — ${res.count} comment${res.count === 1 ? '' : 's'} baked in` : '';
          openInBrowser(url);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Gist created (${params.public ? 'public' : 'secret'})${note}, URL copied to clipboard:\n${url}\n\nNote: gist.github.com shows the source. Share the file itself for the rendered page.`,
              },
            ],
            details: { action, slug, title, method, url, absPath } as Record<string, unknown>,
          };
        } catch (e) {
          return errResult(`share (${method}) failed: ${e instanceof Error ? e.message : String(e)}`, { slug, title });
        }
      }

      // ── create / update — need kind + content ──────────────────────────────
      if (!kind) {
        return errResult('`kind` (markdown or html) is required for create/update.', {
          slug,
          title,
        });
      }
      const resolved = resolveContent(params);
      if ('error' in resolved) {
        return errResult(resolved.error, { slug, title, kind });
      }
      const content = resolved.content;

      const html =
        kind === 'html' ? renderHtmlDocument(title, slug, content) : renderMarkdownDocument(title, slug, content);

      writeArtifact(slug, html);

      // Source mirror for annotation source-line refs (markdown artifacts only;
      // additive — listArtifacts only reads .html).
      if (kind === 'markdown') writeSourceMirror(slug, content);

      // Live-reload already-open tabs (no-op if server not running)
      notifyReload(slug);

      const shouldOpen = params.open ?? action === 'create';
      let url: string | undefined;
      if (shouldOpen) {
        url = await artifactUrl(slug);
        openInBrowser(url);
      } else if (isRunning()) {
        url = await artifactUrl(slug);
      }

      setArtifactStatus(ctx, title, url);
      const details: ArtifactDetails = { action, slug, title, kind, url, absPath };
      const verb = action === 'create' ? 'Created' : 'Updated';
      const text = `${verb} ${title} [${kind}]\n${url ?? '(server not running — use action: open to view)'}\n${absPath}`;
      return {
        content: [{ type: 'text' as const, text }],
        details: details as unknown as Record<string, unknown>,
      };
    },
  });
}
