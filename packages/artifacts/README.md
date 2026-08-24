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
- **Browser UI** — styled artifact pages plus an index page at `/`; live reload via an `/events` SSE endpoint. No TUI widgets, overlays, keybindings, or custom message/entry types: tool results use pi's default rendering (the tool returns structured `details` — `action`, `slug`, `title`, `kind`, `url`, `absPath` — and a text summary containing the clickable localhost URL).

## The `artifact` tool

Parameters (TypeBox schema):

| Param              | Type / values                                       | Default                               | Notes                                                                                             |
| ------------------ | --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `action`           | `create` \| `update` \| `open` \| `list` \| `share` | required                              | `update` on a missing slug creates it                                                             |
| `title`            | string                                              | required for create/update/open/share | slug derived from it (kebab-case, max 80 chars)                                                   |
| `method`           | `clipboard` \| `reveal` \| `gist` \| `image`        | `clipboard` (share only)              | how to hand off the artifact: clipboard copy, file-manager reveal, GitHub gist, or PNG screenshot |
| `public`           | boolean                                             | `false` (share method=gist only)      | make the gist public; default is a secret gist                                                    |
| `width` / `height` | integer                                             | `1280` / `800` (method=image only)    | viewport size for the screenshot; it becomes the image size                                       |
| `kind`             | `markdown` \| `html`                                | required for create/update            | never auto-detected from content                                                                  |
| `content`          | string                                              | —                                     | inline markdown or HTML                                                                           |
| `path`             | string                                              | —                                     | alternative to `content`: read file relative to cwd (2 MB cap; `kind` still required)             |
| `open`             | boolean                                             | `true` on create, `false` on update   | auto-open in browser after write                                                                  |

Behavior per action:

- `create` / `update` — write `<slug>.html` and return slug + localhost URL + absolute path. `update` pushes an SSE reload event to connected browser tabs, so iterating on a report reuses one file and one tab. If `open` is false and the server isn't running, no URL is returned (`(server not running — use action: open to view)`).
- `open` — starts the server (if needed) and opens the artifact in the browser. Errors if the slug doesn't exist.
- `list` — lists artifacts newest-first (title, kind, timestamp, slug, absolute path). Does **not** start the server; URLs are included only if the server is already running.
- `share` — hands the artifact file off, since every artifact is already one self-contained HTML file. `clipboard` (default) copies the rendered HTML (pbcopy / clip / wl-copy); `reveal` shows the file in the OS file manager (Finder via `open -R`), ready to AirDrop or drag into Slack; `gist` runs `gh gist create` under the user's GitHub account (requires the `gh` CLI, authed), copies the URL to the clipboard, and opens it — secret unless `public: true`. Gists display as source, not a rendered page, so `gist` is for durable attributable upload, not for showing someone the rendered report. `image` starts the server (if needed), screenshots the rendered page with a headless Chrome-family browser (`--headless --screenshot`, discovered in /Applications on macOS or `google-chrome` on PATH elsewhere), and writes `<slug>.png` next to the artifact — on macOS the PNG is also placed on the clipboard as an image, ready to paste into Slack or docs. For share cards, author a full-bleed full-document `html` artifact so the card fills the viewport.

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
<project>/.pi/artifacts/<slug>.html
```

- Slug = identity: derived from the title (lowercase, alnum + hyphens, trimmed, 80-char cap; empty result → `artifact`). Slugs are validated against path traversal (`/`, `\`, `..` rejected). `update` with the same slug overwrites the file — collisions are intentional.
- Directory created lazily on first write.
- `.pi/artifacts/` is generated output — gitignore it (`echo ".pi/artifacts/" >> .gitignore`). The extension does not enforce this.
- No `delete` action; clear the directory manually.

## Server (lazy, localhost-only)

- `node:http` server started on first `open`/auto-open (not at extension load), bound strictly to `127.0.0.1`, random free port (`listen(0)`) remembered for the process lifetime. One server per pi process, matching the cwd-relative storage model.
- Routes: `/` (index page), `/<slug>.html` (static artifact files), `/events` (SSE endpoint).
- **SSE live reload**: server and tool run in the same process, so `update` pushes a `reload` event directly to connected clients (no `fs.watch`). Every rendered page embeds a snippet that subscribes to `/events` and reloads only on events matching its own slug (or `*`).
- **Index page** at `/`: artifact list newest-first with kind badge and timestamp. Titles/kind/mtime recovered by regex-parsing each file's `<title>` and `artifact-*` metas — no sidecar manifest.
- Request paths are URL-decoded, normalized, and prefix-checked against the artifacts dir — nothing outside it is served. No auth: localhost-only, serving files the agent just wrote locally.

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

Peer deps: `@earendil-works/pi-coding-agent` (provides `ExtensionAPI` — only `pi.registerTool`, `pi.registerCommand`, and `pi.on` are used), `@earendil-works/pi-tui`, `typebox`. No `@nicknisi/pi-shared` or other workspace deps. One CDN script (mermaid 11) for mermaid fences only.

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
