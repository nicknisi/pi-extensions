# artifacts

Give the agent a way to produce visual output — PR review reports, diagrams, comparison tables, rendered diffs — as **HTML artifacts** served from a lazy localhost server and opened in the browser, instead of dumping walls of text into the terminal. One `artifact` tool (create/update/open/list) writes rendered HTML to `<project>/.pi/artifacts/`, a per-process HTTP server bound to `127.0.0.1` serves it, and SSE live reload refreshes open browser tabs in place on `update`.

https://github.com/user-attachments/assets/b84e0ebd-84db-45ec-ba77-52aede167b4e

## Install

```bash
pi install /Users/nicknisi/Developer/pi-extensions/packages/artifacts
```

## What it adds

- **Tool `artifact`** — action-based (`create` | `update` | `open` | `list` | `share` | `answer`). Registered with a `promptSnippet` ("emit visual output as a browser HTML artifact instead of terminal text") so the model knows when to reach for it.
- **Command `/artifacts`** — in-TUI picker over every generated artifact (newest first, with relative age); Enter opens it in the browser and pins it as the footer status. Without a UI (print/RPC) or with no artifacts yet, falls back to opening the index page (`/`) in the browser.
- **Footer status** — after `create`/`update`/`open`, the artifact's title appears in the footer as a persistent OSC 8 hyperlink to its localhost URL (`setStatus('artifacts', …)`), replacing the previous one. Rendered by pi's built-in footer or any custom footer that surfaces extension statuses (e.g. `@nicknisi/pi-statusline`).
- **Event hook** — `session_shutdown`: stops the HTTP server.
- **Browser UI** — styled artifact pages plus an index page at `/`; live reload via an `/events` SSE endpoint. Each artifact opens in a review page that frames the artifact itself on a separate, isolated origin (see [Annotations](#annotations)). The review page carries a **Share** button (bottom-right): _Copy image_ renders a PNG with the comments panel open (when comments exist), _Copy PDF_ prints to a selectable-text PDF with a Review comments section, _Copy file_ puts the self-contained HTML on your clipboard (comments baked in), _Create gist link_ uploads via `gh` and copies the URL — no agent round-trip needed. No TUI widgets, overlays, keybindings, or custom message/entry types: tool results use pi's default rendering (the tool returns structured `details` — `action`, `slug`, `title`, `kind`, `url`, `absPath` — and a text summary containing the clickable localhost URL).
- **Review panel** — every artifact opens with a comment panel beside it (see [Annotations](#annotations)): select text, comment, and send the comments back to the running agent as a follow-up message.

## Optional extension service

Other extensions can use artifacts without model calls or a mandatory dependency. After `session_start`, emit `plugin-services:v1:discover:nicknisi.artifacts` on the **injected `pi.events`** with `{ offer }`. Offers arrive synchronously as `{ id: 'nicknisi.artifacts', apiMajor: 1, api }`. Optional request `id`/`apiMajor` filters must match. No registry, RPC, additional server, or helper dependency is needed. Missing/incompatible offers should fall back to the consumer's own local HTML file.

`contract.ts` (also exported as `@nicknisi/pi-artifacts/contract`) contains side-effect-free metadata, types, `isArtifactsAPI` and `isArtifactsOffer`. The API has flat, own callable methods:

```ts
publish({ title: string, html: string, open?: boolean })
  // Promise<{ slug: string, url: string, absPath: string }>
answer({ slug: string, annotationId: string, content: string })
  // Promise<{ ok: true }>
subscribe({ slug: string, onFeedback })
  // Promise<() => void>
// onFeedback({ slug, markdown, annotationIds: string[] }): boolean | Promise<boolean>
```

- `publish` uses the existing HTML renderer, previous-revision snapshot, storage, lazy server and live reload. Full documents or fragments are accepted, up to 2 MiB UTF-8; title must be nonempty (at most 4000 characters). Reuse the same title to update the same slug/URL; slugification is the same as the tool (80 characters, so callers should use unique run titles). Callers own update ordering/coalescing and should await sequential updates. Only `open: true` opens a browser tab. No model is involved.
- Publication preserves annotation/evidence sidecars and authored `id`/`data-artifact-anchor` attributes. Supply stable anchors in each revision. As with HTML tool updates, a stale Markdown source mirror is removed. The service does not invent or rewrite native decision/evidence controls; include desired markup in each HTML update. Ordinary tool decision/evidence behavior is unchanged.
- `answer` uses the existing sent-question storage and annotation notification without rewriting HTML.
- Each slug has one subscriber. Duplicate subscriptions reject rather than stealing ownership. Await subscription before requesting feedback. The unsubscribe function is idempotent and cannot remove a newer subscription.
- Unowned feedback retains the ordinary `pi.sendUserMessage(..., { deliverAs: 'followUp' })` route. Owned feedback goes **only** to that owner. Its boolean completion is awaited; false, rejection or service disposal leaves the batch undelivered (HTTP 503), never falling back to another session. Concurrent sends and draft saves for that slug receive 409 until delivery settles; browser drafts must be retained and retried. Other slugs remain usable. Consumers should durably deduplicate `annotationIds` before acknowledging: this is not crash-proof exactly-once delivery.
- Shutdown removes discovery/subscriptions and guards all retained method references. Rediscover and resubscribe in the new session; do not reuse old session callbacks. Runtime sockets remain lazy and session-scoped. A callback already executing cannot be cancelled by this protocol; consumers must guard their own session lifetime too.

This is a compatibility convention, **not authentication or a security boundary**. Providers, consumers, callbacks and supplied HTML are trusted local extension code. Comments/decision selections are review feedback, not approval or authorization.

## The `artifact` tool

Parameters (TypeBox schema):

| Param              | Type / values                                                   | Default                             | Notes                                                                                                        |
| ------------------ | --------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `action`           | `create` \| `update` \| `open` \| `list` \| `share` \| `answer` | required                            | `answer` adds a reply without editing the artifact                                                           |
| `title`            | string                                                          | required except for list            | slug derived from it, kebab-case with an 80-character cap                                                    |
| `annotationId`     | string                                                          | required for answer                 | ID of a sent question                                                                                        |
| `decisions`        | array                                                           | `[]`                                | Native choices. See Questions, decisions, and evidence below.                                                |
| `evidence`         | array                                                           | `[]`                                | Expandable source material. See Questions, decisions, and evidence below.                                    |
| `method`           | `clipboard` \| `reveal` \| `gist` \| `image` \| `pdf`           | `clipboard` (share only)            | how to hand off the artifact: clipboard copy, file-manager reveal, GitHub gist, PNG screenshot, or PDF print |
| `public`           | boolean                                                         | `false` (share method=gist only)    | make the gist public; default is a secret gist                                                               |
| `width` / `height` | integer                                                         | `1280` / `800` (method=image only)  | viewport size for the screenshot; it becomes the image size                                                  |
| `kind`             | `markdown` \| `html`                                            | required for create/update          | never auto-detected from content                                                                             |
| `content`          | string                                                          | —                                   | inline markdown or HTML                                                                                      |
| `path`             | string                                                          | —                                   | alternative to `content`: read file relative to cwd (2 MB cap; `kind` still required)                        |
| `open`             | boolean                                                         | `true` on create, `false` on update | auto-open in browser after write                                                                             |

Behavior per action:

- `answer` adds `content` as a reply to a sent question identified by `annotationId`. The reply appears in the browser through SSE. It does not rewrite the document.
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

Rendered to styled HTML at write time via [`marked`](https://marked.js.org/) (GFM tables, task lists). Markdown uses the Confetti reader: a rounded document surface, a desktop section outline, and a header with reading controls. **Aa** switches between 18px and 21px reading text. **Light / Dark** changes the reader and review panel without reloading or discarding drafts. These preferences use browser local storage for the current server origin and still work for the current page when storage is unavailable.

Code blocks have a language label and **Copy** button that copies the original text. Wide tables scroll in keyboard-focusable regions. Heading links preserve authored IDs and disambiguate repeated headings. Print hides the reader controls and outline. Nunito Sans is embedded as a Latin WOFF2 font with its SIL Open Font License, so typography needs no font service. Other scripts use system fallbacks.

Fenced code blocks are handled per language:

- ` ```diff ` fences → rendered **server-side** via [`diff2html`](https://github.com/rtfpessoa/diff2html) (Node API, line-by-line, no file list). Malformed diffs fall back to plain code blocks. Offline-safe.
- Known-language fences (` ```ts `, ` ```py `, …) → syntax-highlighted **server-side** via [`highlight.js`](https://highlightjs.org/); highlighted spans are baked into the HTML. Unknown languages fall back to plain escaped code (no unreliable auto-detect on short snippets).
- ` ```mermaid ` fences → rendered **client-side** via the mermaid CDN script, pinned to an exact version with a subresource integrity hash (`MERMAID_CDN` / `MERMAID_SRI` in `config.ts`; bump both together). A changed file fails to load instead of running next to the review API. This is the reader's only external script. Mermaid artifacts need network on first view. Mermaid uses its `base` theme fed from the document's CSS variables when rendered. Already-rendered diagrams and authored SVG/images retain their colors when the reader theme is toggled.

### `kind: "html"` (escape hatch)

For what markdown can't express: custom layout, Chart.js pages, interactive widgets.

- **Body fragment** → injected into the styled shell as-is. Fragments inherit the artifact stylesheet and its CSS variables — `--bg`, `--fg`, `--muted`, `--border`, `--code-bg`, `--accent` — so write semantic HTML and use those variables in scoped `<style>` blocks instead of hardcoding colors.
- **Full document** (`<!DOCTYPE`/`<html>` detected) → passed through unchanged, except the extension splices in the shell's metadata metas (`artifact-kind` / `artifact-generated` / `artifact-project`, skipping any the doc already declares) and the SSE reload listener. Both are passive; they keep full-doc html consistent on the index page and let the file live-reload when opened on its own. In the review page, the frame is reloaded by the page instead.

Kind is never auto-detected from content — markdown legitimately opens with inline HTML, and misdetection produces a confusing artifact.

## Storage

Project-local, mirroring plan-mode's `.pi/plans` convention:

```
<project>/.pi/artifacts/<slug>.html            # the artifact
<project>/.pi/artifacts/<slug>.md              # markdown source mirror (markdown kind only; enables source-line refs)
<project>/.pi/artifacts/<slug>.annotations.json # comment drafts (written by the annotation layer)
<project>/.pi/artifacts/<slug>.clips/<id>.png   # one screenshot per pinned or text comment
<project>/.pi/artifacts/.server-port            # last port the server used, tried first next time
```

- Slug = identity: derived from the title (lowercase, alnum + hyphens, trimmed, 80-char cap; empty result → `artifact`). Slugs are validated against path traversal (`/`, `\`, `..` rejected). `update` with the same slug overwrites the file — collisions are intentional.
- Directory created lazily on first write.
- `.pi/artifacts/` is generated output — gitignore it (`echo ".pi/artifacts/" >> .gitignore`). The extension does not enforce this.
- No `delete` action; clear the directory manually.

## Server (lazy, localhost-only)

- `node:http` server started on first `open`/auto-open (not at extension load), bound strictly to `127.0.0.1`, on the project's previous port when it is free (kept in `.pi/artifacts/.server-port`), else a random free port. Reusing the port lets tabs left open across a restart or `/new` reconnect and keep unsent drafts. One server per pi process, matching the cwd-relative storage model.
- Routes on `127.0.0.1:<port>`: `/` lists artifacts, `/<slug>.html` serves the review page, and `/events` carries reload and answer events. `GET /api/annotations?slug=...` reads review state, `PUT /api/annotations` saves drafts, `POST /api/feedback` delivers a batch, `POST /api/clips` stores a comment's screenshot, `POST /api/render` previews comment Markdown, and `POST /api/share` exports. `GET /api/revision?slug=...` opens the previous/current comparison. On `localhost:<port>`, the artifact's own origin, only `/c/<file>` (the artifacts themselves and their files, never review state or server files) and `/_artifacts/modern-screenshot.mjs` (the screenshot library) are served.
- **SSE live reload**: server and tool run in the same process, so `update` pushes a `reload` event directly to connected clients (no `fs.watch`). The review page subscribes to `/events` and reloads the framed artifact on events matching its slug (or `*`). The reload listener baked into stored files is dropped when they are served in the frame.
- **Index page** at `/`: artifact list newest-first with kind badge and timestamp. Titles/kind/mtime recovered by regex-parsing each file's `<title>` and `artifact-*` metas — no sidecar manifest.
- Request paths are URL-decoded, normalized, and prefix-checked against the artifacts dir — nothing outside it is served. No auth: localhost-only, serving files the agent just wrote locally. Every request must name this server in its `Host` header (`127.0.0.1:<port>` or `localhost:<port>`); anything else is 403, which stops DNS rebinding (a website that points its own domain at 127.0.0.1).

## Annotations

`/<slug>.html` is a review page: the review panel, plus the artifact in an iframe served from `localhost:<port>/c/<slug>.html`, a different origin from the review page and its API on `127.0.0.1:<port>`. A small script added to the framed artifact at serve time (the bridge) handles selections, pins, highlights, decisions, colors, and screenshots, and talks to the panel only through checked `postMessage` calls. The stored `.html` (and anything read from it: gist uploads, clipboard shares) stays byte-clean. The **Review** button opens a sidebar with the composer, draft comments, and send control together; on desktop the artifact narrows to make room, and smaller screens use a bottom sheet. The panel takes its colors from the artifact and follows its theme toggle.

Inside the frame, links to other sites open in a new tab (most sites refuse to be framed), and the artifact cannot navigate the review page. Artifacts share the `localhost:<port>` origin with each other, so browser storage they use is shared between them.

**Commenting**: click **Review** and write feedback for the whole document, or select a passage first. The composer has visible **Comment**, **Question**, and **Keep this** choices. Comment requests a change, Question requests an explanation, and Keep this marks content to preserve. Markdown and Preview are supported. Use **Add to review** to collect several comments, or send the typed comment directly. Closing the panel or pressing `Esc` preserves unfinished text. Add or clear it before choosing a different passage. Drafts can be edited or deleted in the panel. Text comments appear as highlights through the CSS Custom Highlight API.

**Visual pins**: choose **Pin a visual**, then click an image, SVG diagram, figure, table, canvas, or element with `data-artifact-anchor`. Keyboard users can Tab to a target and press Enter. Click a comment's anchor to return to it. Author stable `id` or `data-artifact-anchor` attributes where possible. Structural fallback selectors are best-effort and can become stale after layout changes. The browser marks missing or ambiguous targets stale. The agent receives the element label and selector, plus a screenshot (below).

**Screenshots**: adding a pinned or text comment also takes a PNG of its region as you see it (theme, layout, and page state included) and stores it in `<slug>.clips/<annotation id>.png`. A pin captures its element. A text comment captures the block holding the selection with the selected text tinted, cropped to 120px around it when the block is tall. General and decision comments have none. The feedback message names each file, so the agent can read it. Capture runs in the page with [`modern-screenshot`](https://github.com/qq15725/modern-screenshot), loaded only when needed. It is best-effort: blocks taller than 4000px, images over about 5.5 MB, and failed renders are skipped silently, and **Send review** waits at most 8 seconds for unfinished captures. Deleting a draft deletes its screenshot. Sent comments keep theirs.

**Sent feedback**: sending retains comments in a collapsed **Sent feedback** section. Sent records are read-only and excluded from later sends. Sent means delivered, not resolved. Question answers appear there without reloading the document. Shared HTML, images, and PDFs include retained feedback unless annotations are excluded.

**Revision comparison**: **View changes** opens themed, rendered Previous and Current previews. Scripts cannot run, external assets cannot load, and form controls are disabled. Text stays readable to assistive technology. Expand **Source changes** for the previous source comparison with the changed region highlighted. Markdown comparisons use the source mirror unless decision or evidence sections changed. Only one previous revision is retained in `<slug>.previous.json`. This is not a granular line diff or full version history.

**Drafts persist**: every add/edit/delete saves to `<slug>.annotations.json`. Saves are serialized, and send/share waits for persistence. Revision tokens reject outdated writes from another tab rather than silently overwriting feedback. If a conflict occurs, copy your unsaved feedback before reloading. A live reload replaces only the framed artifact, so drafts, the composer, and an edit in progress are untouched. If an update removes a quoted passage, its comment is marked **stale** rather than dropped. The server rechecks text quotes when sending. General comments do not depend on an anchor.

**Submitting**: **Send review** includes any comment still in the composer and sends the current draft batch to the running pi session as one follow-up user message through `pi.sendUserMessage`. Each record includes its annotation ID and intent. Questions explicitly request an answer rather than an edit, and keep comments identify content to preserve. Selection feedback never grants permission for destructive actions or deployments. The sidecar retains successfully sent records. The message includes the artifact URL, quoted passages or element references, and source lines where available:

```markdown
# Artifact Annotations

Artifact: sprint-report (http://127.0.0.1:PORT/sprint-report.html)

Screenshots are PNGs of each commented region as the reviewer saw it, with any quoted text tinted. Read them when a comment is about how something looks.

1. > "Deploys rose 40% after the migration" (source line 5) [annotationId: mvf1a2b3-1234]
   > Screenshot: /path/to/project/.pi/artifacts/sprint-report.clips/mvf1a2b3-1234.png

   Which migration? Cite the PR.

2. [stale] > "No incidents were recorded" [annotationId: mvf1a2c4-5678]

   Wrong — link the Feb outage retro.

(2 comments · 1 stale)
```

`(source line N)` appears for markdown artifacts when the quote is found verbatim in the source mirror (`.md`); it is omitted for raw HTML artifacts and quotes that span markdown formatting. If delivery fails, nothing is lost: when the server is up but has no live session to deliver to, it answers 503 with the composed message in the response and the page offers a Copy button; when the server itself is gone (e.g. `/new` stopped it), the draft comments stay in the sidecar and can be submitted after the next `open`.

**Threat model**: the server is loopback-only (`127.0.0.1`), without authentication, and refuses requests whose `Host` is not its own. Mutation endpoints require JSON and reject a different browser Origin. Native local clients without an Origin header remain supported. Requests have a 1 MB body cap (about 8 MB for screenshot uploads), and annotation records are validated and stripped of unknown fields. A screenshot is stored only for an already-saved comment whose ID is filename-safe, and only when the bytes are a PNG of at most 6 MB. Browser requests cannot forge replies or erase sent records. Comment Markdown escapes raw HTML and blocks unsafe link schemes. Artifact HTML is agent-authored executable content, and may carry content from elsewhere (raw HTML in Markdown, CDN scripts), so it is kept away from the API: it runs on its own origin in a sandboxed frame (scripts, forms, popups, and downloads allowed; navigating the review page is not), the API answers only on the review page's origin, and writes from any other origin are refused. The bridge's messages are proposals: an artifact can offer an anchor, a decision selection, or a screenshot, which show up in the panel, but comment text is only what you type and sending is only your click. Image and PDF share renders load the artifact on its own origin too, with a read-only review baked in.

### Questions, decisions, and evidence

Answer a sent question with the same tool. This changes the comment sidecar, not the artifact:

```json
{
  "action": "answer",
  "title": "Sprint report",
  "annotationId": "ID from the feedback message",
  "content": "The migration was PR #412."
}
```

For `create` or `update`, optional `decisions` and `evidence` arrays add native controls. Supply the arrays again on updates to retain them. IDs must contain only letters, numbers, underscores, or hyphens. Each collection accepts up to 50 entries.

```json
{
  "action": "create",
  "title": "Storage proposal",
  "kind": "markdown",
  "content": "SQLite avoids a separate server. [Source](#artifact-evidence-proof)",
  "decisions": [
    {
      "id": "storage",
      "question": "Which storage should we use?",
      "options": [
        { "value": "sqlite", "label": "SQLite" },
        { "value": "postgres", "label": "Postgres" }
      ],
      "multiple": false
    }
  ],
  "evidence": [
    {
      "id": "proof",
      "title": "Captured benchmark result",
      "source": "bench/storage.ts:42, local benchmark command",
      "quote": "Paste the actual captured result here.",
      "url": "https://example.com/source"
    }
  ]
}
```

Decisions use radio buttons by default, or checkboxes with `multiple: true`. Changes persist as draft comments and are sent only by **Send review**. Each decision needs 2–50 choices with unique values. To place a choice beside a particular paragraph, author a native `<fieldset data-artifact-decision="id">` with a `<legend>` and labeled radio or checkbox inputs in the artifact content. Reuse IDs across revisions to restore saved selections.

Evidence uses native expandable `<details>`. Link a claim to `#artifact-evidence-ID` to open its evidence. Each entry needs a title and at least one of `source`, `quote`, or an HTTP(S) `url`. Text fields are capped at 4,000 characters. Source labels can identify file lines, commits, or commands. The extension does not fetch files, run commands, or independently verify claims. Include exact supporting passages or captured output, not invented evidence.

## `/artifacts` command

```
/artifacts
```

User-facing front door. With a UI, shows a select list of all generated artifacts (title, kind, relative age — newest first); picking one starts the lazy server if needed, opens it in the browser, and pins it as the footer status. Esc cancels. With no UI (print/RPC) or no artifacts yet, opens the browser index page instead. No args, no subcommands.

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

Markdown defaults to coral accents (`#ffa293` dark, `#b74445` light). Explicit `accent` and `accentLight` settings override those defaults too. `theme` sets the initial reader scheme unless a browser preference has been saved. No new config keys are required.

## Styling

No CSS framework. `reader.ts` and `reader-styles.ts` provide the Markdown-only Confetti reader. HTML fragments and the index retain the existing `styles.ts` design: system fonts, fixed 15px base, compact spacing, hairline borders, and one accent color. Light and dark schemes are flat token sets. diff2html's base CSS (read from the installed package via `createRequire`, so it can't drift from its JS) is compacted to code-block scale and recolored through the same tokens; the highlight.js theme is mapped onto scheme tokens too. diff2html and highlight.js CSS are inlined only into pages that need them (flagged during markdown render).

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
- `modern-screenshot` — in-page PNG capture for comment screenshots; served to the page by the artifact server and loaded only when a comment is added.
- `typebox` — tool parameter schema.

Peer deps: `@earendil-works/pi-coding-agent` (provides `ExtensionAPI` — only `pi.registerTool`, `pi.registerCommand`, and `pi.on` are used), `@earendil-works/pi-tui`, `typebox`. No `@nicknisi/pi-shared` or other workspace deps. One CDN script (mermaid, version-pinned with an integrity hash) for mermaid fences only. A Chrome-family browser binary is needed for `image`/`pdf` shares (and nothing else).

## Caveats

- **Uses only the public extension API** (`registerTool` / `registerCommand` / `on("session_shutdown")` / `ctx.ui.setStatus` / `ctx.ui.select`) — no pi internals. Should be stable across pi versions modulo API changes in those calls.
- **Config is loaded once at extension load** (pi extensions load at session start) — edit `artifacts.json`, then restart pi.
- **Mermaid artifacts need network** on first view (CDN script). Everything else is rendered at write time and viewable offline.
- **Server lifetime = process lifetime.** The server stops on `session_shutdown`; the next session in the same project reuses its port when free. Artifacts persist on disk and can be re-served by a later session.
- **Server is per-process and cwd-keyed.** Two pi sessions in different projects each run their own server on different ports; artifact URLs from one session don't resolve in the other.
- **Footer status uses a nerd-font glyph** (`\u{F0C5}`) — terminals without a nerd font show tofu for the icon; the link itself is unaffected.
- **Browser open is platform-specific**: `open` (macOS), `rundll32 url.dll,FileProtocolHandler` (Windows — `start` is a cmd.exe builtin and can't be spawned), `xdg-open` (Linux). Failures only warn.
- **`path` param is capped at 2 MB** — excerpt large files into `content` instead.
- **Index-page metadata is regex-parsed** from each file's `<title>`/`<meta>` tags. Foreign `.html` files dropped into `.pi/artifacts/` are listed with kind inferred from the presence of the shell's `<style data-base>` marker.
- **diff2html CSS is read via `createRequire(...).resolve("diff2html/bundles/css/diff2html.min.css")`** — breaks if diff2html changes its package layout.
- **`update` on a missing slug silently creates** — intentional, but the model (and you) should not rely on `update` failing for typos.
