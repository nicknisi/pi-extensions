# artifacts

Give the agent a way to produce visual output — PR review reports, diagrams, comparison tables, rendered diffs — as **HTML artifacts** served from a lazy localhost server and opened in the browser, instead of dumping walls of text into the terminal. One `artifact` tool (create/update/open/list) writes rendered HTML to `<project>/.pi/artifacts/`, a per-process HTTP server bound to `127.0.0.1` serves it, and SSE live reload refreshes open browser tabs in place on `update`.

https://github.com/user-attachments/assets/b84e0ebd-84db-45ec-ba77-52aede167b4e

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/artifacts
```

## What it adds

- **Tool `artifact`** — action-based (`create` | `update` | `open` | `list` | `share`). Registered with a `promptSnippet` ("emit visual output as a browser HTML artifact instead of terminal text") so the model knows when to reach for it.
- **Command `/artifacts`** — starts the lazy server and opens the index page (`/`) in the browser.
- **Event hook** — `session_shutdown`: stops the HTTP server.
- **Browser UI** — styled artifact pages plus an index page at `/`; live reload via an `/events` SSE endpoint. Every served artifact page carries a **Share** button (bottom-right): _Copy image_ renders a PNG with the comments panel open (when comments exist), _Copy PDF_ prints to a selectable-text PDF with a Review comments section, _Copy file_ puts the self-contained HTML on your clipboard (comments baked in), _Create gist link_ uploads via `gh` and copies the URL — no agent round-trip needed. No TUI widgets, overlays, keybindings, or custom message/entry types: tool results use pi's default rendering (the tool returns structured `details` — `action`, `slug`, `title`, `kind`, `url`, `absPath` — and a text summary containing the clickable localhost URL).
- **Annotation layer** — every served artifact page carries an inert comment layer (see [Annotations](#annotations)): select text, comment, and send the comments back to the running agent as a follow-up message.

## The `artifact` tool

Parameters (TypeBox schema):

| Param              | Type / values                                         | Default                               | Notes                                                                                                        |
| ------------------ | ----------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `action`           | `create` \| `update` \| `open` \| `list` \| `share`   | required                              | `update` on a missing slug creates it                                                                        |
| `title`            | string                                                | required for create/update/open/share | slug derived from it (kebab-case, max 80 chars)                                                              |
| `method`           | `clipboard` \| `reveal` \| `gist` \| `image` \| `pdf` | `clipboard` (share only)              | how to hand off the artifact: clipboard copy, file-manager reveal, GitHub gist, PNG screenshot, or PDF print |
| `public`           | boolean                                               | `false` (share method=gist only)      | make the gist public; default is a secret gist                                                               |
| `width` / `height` | integer                                               | `1280` / `800` (method=image only)    | viewport size for the screenshot; it becomes the image size                                                  |
| `kind`             | `markdown` \| `html`                                  | required for create/update            | never auto-detected from content                                                                             |
| `content`          | string                                                | —                                     | inline markdown or HTML                                                                                      |
| `path`             | string                                                | —                                     | alternative to `content`: read file relative to cwd (2 MB cap; `kind` still required)                        |
| `open`             | boolean                                               | `true` on create, `false` on update   | auto-open in browser after write                                                                             |

Behavior per action:

- `create` / `update` — write `<slug>.html` and return slug + localhost URL + absolute path. `update` pushes an SSE reload event to connected browser tabs, so iterating on a report reuses one file and one tab. If `open` is false and the server isn't running, no URL is returned (`(server not running — use action: open to view)`).
- `open` — starts the server (if needed) and opens the artifact in the browser. Errors if the slug doesn't exist.
- `list` — lists artifacts newest-first (title, kind, timestamp, slug, absolute path). Does **not** start the server; URLs are included only if the server is already running.
- `share` — hands the artifact file off, since every artifact is already one self-contained HTML file. `clipboard` (default) copies the rendered HTML (pbcopy / clip / wl-copy); `reveal` shows the file in the OS file manager (Finder via `open -R`), ready to AirDrop or drag into Slack; `gist` runs `gh gist create` under the user's GitHub account (requires the `gh` CLI, authed), copies the URL to the clipboard, and opens it — secret unless `public: true`. Gists display as source, not a rendered page, so `gist` is for durable attributable upload, not for showing someone the rendered report. `image` starts the server (if needed), screenshots the rendered page with a headless Chrome-family browser (`--headless --screenshot`, discovered in /Applications on macOS or `google-chrome` on PATH elsewhere), and writes `<slug>.png` next to the artifact — on macOS the PNG is also placed on the clipboard as an image, ready to paste into Slack or docs. `pdf` does the same with `--print-to-pdf`, writing `<slug>.pdf` and copying the file reference on macOS. When the artifact has comments, image renders with the comments panel open and PDF with a Review comments section appended (via the serve-time URL modes `?panel=open` / `?print=1`; `annotations: false` opts out). For share cards, author a full-bleed full-document `html` artifact so the card fills the viewport.

  **Comments ride along**: when the artifact has annotation comments, `clipboard` and `gist` bake them into the shared file — highlights painted on the text plus a read-only comments panel behind an "N comments" pill (the layer's static mode; nothing can be edited or submitted from a shared file). Pass `annotations: false` to share the clean file. `reveal` and `image` are unchanged — `image` incidentally captures highlights, since the served page hydrates them.

Example tool call (as the model would emit it):

````json
{
  "action": "create",
  "title": "PR #412 Review",
  "kind": "markdown",
  "content": "# Review: PR #412\n\n## Findings\n\n| Severity | File | Issue |\n|---|---|---|\n| high | `src/auth.ts` | ... |\n\n```diff\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ ...\n```"
}
````

### `kind: "markdown"` (workhorse)

Rendered to styled HTML at write time via [`marked`](https://marked.js.org/) (GFM tables, task lists). Fenced code blocks are handled per language:

- ` ```diff ` fences → rendered **server-side** via [`diff2html`](https://github.com/rtfpessoa/diff2html) (Node API, line-by-line, no file list). Malformed diffs fall back to plain code blocks. Offline-safe.
- Known-language fences (` ```ts `, ` ```py `, …) → syntax-highlighted **server-side** via [`highlight.js`](https://highlightjs.org/); highlighted spans are baked into the HTML. Unknown languages fall back to plain escaped code (no unreliable auto-detect on short snippets).
- ` ```mermaid ` fences → rendered **client-side** via the mermaid 11 CDN script (`https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js`). This is the **only** client-side JS in a markdown artifact; mermaid artifacts need network on first view. Mermaid uses its `base` theme fed from the document's CSS variables at runtime, so diagrams follow the scheme and configured accent.

### `kind: "html"` (escape hatch)

For what markdown can't express: custom layout, Chart.js pages, interactive widgets.

- **Body fragment** → injected into the styled shell as-is. Fragments inherit the artifact stylesheet and its CSS variables — `--bg`, `--fg`, `--muted`, `--border`, `--code-bg`, `--accent` — so write semantic HTML and use those variables in scoped `<style>` blocks instead of hardcoding colors.
- **Full document** (`<!DOCTYPE`/`<html>` detected) → passed through unchanged, except the extension splices in the shell's metadata metas (`artifact-kind` / `artifact-generated` / `artifact-project`, skipping any the doc already declares) and the SSE reload listener. Both are passive; they keep full-doc html consistent on the index page and let `update` live-reload it.

Kind is never auto-detected from content — markdown legitimately opens with inline HTML, and misdetection produces a confusing artifact.

## Storage

Project-local, mirroring plan-mode's `.pi/plans` convention:

```
<project>/.pi/artifacts/<slug>.html            # the artifact
<project>/.pi/artifacts/<slug>.md              # markdown source mirror (markdown kind only; enables source-line refs)
<project>/.pi/artifacts/<slug>.annotations.json # comment drafts (written by the annotation layer)
```

- Slug = identity: derived from the title (lowercase, alnum + hyphens, trimmed, 80-char cap; empty result → `artifact`). Slugs are validated against path traversal (`/`, `\`, `..` rejected). `update` with the same slug overwrites the file — collisions are intentional.
- Directory created lazily on first write.
- `.pi/artifacts/` is generated output — gitignore it (`echo ".pi/artifacts/" >> .gitignore`). The extension does not enforce this.
- No `delete` action; clear the directory manually.

## Server (lazy, localhost-only)

- `node:http` server started on first `open`/auto-open (not at extension load), bound strictly to `127.0.0.1`, random free port (`listen(0)`) remembered for the process lifetime. One server per pi process, matching the cwd-relative storage model.
- Routes: `/` (index page), `/<slug>.html` (static artifact files, annotation layer injected at serve time), `/events` (SSE endpoint), `PUT /api/annotations` (draft persistence), `POST /api/feedback` (compose + deliver to the agent), `POST /api/render` (comment markdown preview), `POST /api/share` (the in-page Share button; copy or gist).
- **SSE live reload**: server and tool run in the same process, so `update` pushes a `reload` event directly to connected clients (no `fs.watch`). Every rendered page embeds a snippet that subscribes to `/events` and reloads only on events matching its own slug (or `*`).
- **Index page** at `/`: artifact list newest-first with kind badge and timestamp. Titles/kind/mtime recovered by regex-parsing each file's `<title>` and `artifact-*` metas — no sidecar manifest.
- Request paths are URL-decoded, normalized, and prefix-checked against the artifacts dir — nothing outside it is served. No auth: localhost-only, serving files the agent just wrote locally.

## Annotations

Every artifact page served by the localhost server carries an inert annotation layer — injected at serve time, so the stored `.html` (and anything read from it: gist uploads, clipboard shares) stays byte-clean. The only always-visible element is a small **Annotate** button in the bottom-right corner.

**Commenting**: click Annotate (or it shows a badge with the existing count), select any text in the page, and add a comment in the popover. Comments appear as in-page highlights (via the CSS Custom Highlight API — browsers without it simply skip the highlights) and in the side panel, where each can be edited or deleted. `Esc` exits annotate mode.

**Drafts persist**: every add/edit/delete saves the full list to `<slug>.annotations.json` next to the artifact, so comments survive live reloads and server restarts. If an `update` removes a quoted passage, that comment is marked **stale** (badge in the panel) rather than dropped — the server re-checks every quote against the current artifact text at submit time.

**Submitting**: "Send to the agent" posts the artifact's slug; the server composes one markdown message and delivers it to the running pi session as a follow-up user message (`pi.sendUserMessage(..., { deliverAs: 'followUp' })`), then deletes the sidecar (delivered = consumed). What the agent receives:

```markdown
# Artifact Annotations

Artifact: sprint-report (http://127.0.0.1:PORT/sprint-report.html)

1. > "Deploys rose 40% after the migration" (source line 5)

   Which migration? Cite the PR.

2. [stale] > "No incidents were recorded"

   Wrong — link the Feb outage retro.

(2 comments · 1 stale)
```

`(source line N)` appears for markdown artifacts when the quote is found verbatim in the source mirror (`.md`); it is omitted for raw HTML artifacts and quotes that span markdown formatting. If delivery fails, nothing is lost: when the server is up but has no live session to deliver to, it answers 503 with the composed message in the response and the page offers a Copy button; when the server itself is gone (e.g. `/new` stopped it), the draft comments stay in the sidecar and can be submitted after the next `open`.

**Threat model**: same as the server itself — loopback-only (`127.0.0.1`), no auth. The write endpoints add slug validation (the same path-traversal guard used for serving) and a 1 MB request-body cap. The annotation script is injected into raw-HTML artifacts too, so it is built to tolerate arbitrary agent-authored DOM (fixed-position UI + CSS Highlight ranges; no mutation of page content). Note any local page can POST these endpoints: worst case is an uninvited _secret_ gist of an artifact (created under your account, visible to you) or feedback delivered to the agent — annoying, not destructive.

## `/artifacts` command

```
/artifacts
```

User-facing front door: starts the lazy server if needed and opens the index page in the browser. No args, no subcommands — the index page is the listing and the picker.

## Configuration

One optional config file, read once at extension load (restart pi to apply changes):

```
~/.pi/agent/configs/artifacts.json
```

The path follows pi's agent dir, so it moves with `PI_CODING_AGENT_DIR` if you
set it.

Copy [`artifacts.example.json`](artifacts.example.json) there. All keys optional; invalid values fall back to defaults.

| Key           | Type                        | Default   | Meaning                                                                         |
| ------------- | --------------------------- | --------- | ------------------------------------------------------------------------------- |
| `theme`       | `auto` \| `light` \| `dark` | `auto`    | `auto` follows the OS via `prefers-color-scheme`; `light`/`dark` pin one scheme |
| `accent`      | string (CSS color)          | `#d67858` | Accent (links, badge, blockquote) on the dark scheme                            |
| `accentLight` | string (CSS color)          | `#b95730` | Accent on the light scheme (darker for contrast on white)                       |
| `maxWidth`    | number (px, > 300)          | `860`     | Content column width                                                            |

No environment variables are read.

## Styling

No CSS framework. `styles.ts` owns the design system: system fonts, fixed 15px base (no viewport scaling), GitHub-README density, hairline borders, one accent color. Light and dark schemes are flat token sets. diff2html's base CSS (read from the installed package via `createRequire`, so it can't drift from its JS) is compacted to code-block scale and recolored through the same tokens; the highlight.js theme is mapped onto scheme tokens too. diff2html and highlight.js CSS are inlined only into pages that need them (flagged during markdown render).

## The "when" layer (prompt, not code)

The extension makes artifacts _possible_; instructions decide _when_. Not part of this package, but the intended companions:

1. A **`pr-review` skill** — gather the PR diff via `gh`, review it, emit one markdown artifact (verdict up top, findings ranked by severity, per-file ` ```diff ` fences) and open it.
2. An **`APPEND_SYSTEM.md`** line covering the long tail (reports, diagrams, tables longer than a screen).

Tuning _when_ artifacts appear never touches extension code.

## Dependencies

Runtime npm deps (declared in `package.json`):

- `marked` — markdown → HTML (GFM).
- `diff2html` — server-side rendering of ` ```diff ` fences; its bundled CSS is read from the installed package at load time.
- `highlight.js` — server-side syntax highlighting baked into the HTML.
- `typebox` — tool parameter schema.

Peer deps: `@earendil-works/pi-coding-agent` (provides `ExtensionAPI` — only `pi.registerTool`, `pi.registerCommand`, and `pi.on` are used), `@earendil-works/pi-tui`, `typebox`. No `@nicknisi/pi-shared` or other workspace deps. One CDN script (mermaid 11) for mermaid fences only. A Chrome-family browser binary is needed for `image`/`pdf` shares (and nothing else).

## Caveats

- **Uses only the public extension API** (`registerTool` / `registerCommand` / `on("session_shutdown")`) — no pi internals. Should be stable across pi versions modulo API changes in those three calls.
- **Config is loaded once at extension load** (pi extensions load at session start) — edit `artifacts.json`, then restart pi.
- **Mermaid artifacts need network** on first view (CDN script). Everything else is rendered at write time and viewable offline.
- **Server lifetime = process lifetime.** Port is held in module state; the server stops on `session_shutdown`. Artifacts persist on disk and can be re-served by a later session.
- **Server is per-process and cwd-keyed.** Two pi sessions in different projects each run their own server on different ports; artifact URLs from one session don't resolve in the other.
- **Browser open is platform-specific**: `open` (macOS), `rundll32 url.dll,FileProtocolHandler` (Windows — `start` is a cmd.exe builtin and can't be spawned), `xdg-open` (Linux). Failures only warn.
- **`path` param is capped at 2 MB** — excerpt large files into `content` instead.
- **Index-page metadata is regex-parsed** from each file's `<title>`/`<meta>` tags. Foreign `.html` files dropped into `.pi/artifacts/` are listed with kind inferred from the presence of the shell's `<style data-base>` marker.
- **diff2html CSS is read via `createRequire(...).resolve("diff2html/bundles/css/diff2html.min.css")`** — breaks if diff2html changes its package layout.
- **`update` on a missing slug silently creates** — intentional, but the model (and you) should not rely on `update` failing for typos.
