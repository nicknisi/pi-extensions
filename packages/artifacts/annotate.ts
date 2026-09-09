/**
 * Serve-time-injected annotation layer. `annotateSnippet(slug, annotationsJson)`
 * returns an escaped JS+CSS string that `server.ts` splices before `</body>`.
 *
 * Same convention as `sseSnippet`/`mermaidSnippet` in templates.ts: an exported
 * function that builds a `<script>` string by plain concatenation, with embedded
 * values passed through JSON.stringify (and `<` escaped so annotation JSON can
 * never break out of the tag). The root element carries the `data-artifact-annotate`
 * marker. Vanilla JS, zero deps, tolerant of arbitrary agent-authored DOM.
 */

/**
 * Splice the annotation layer into an artifact HTML document, before `</body>`
 * (appended if absent). Used at serve time (live mode) and bake time (static).
 */
export function injectAnnotations(
  html: string,
  slug: string,
  annotationsJson: string,
  opts?: { static?: boolean; revision?: string },
): string {
  const snippet = annotateSnippet(slug, annotationsJson, opts);
  const bodyClose = html.search(/<\/body>/i);
  return bodyClose !== -1 ? html.slice(0, bodyClose) + snippet + html.slice(bodyClose) : html + snippet;
}

/**
 * @param slug            the artifact slug (used for PUT/POST bodies)
 * @param annotationsJson `JSON.stringify(annotations)` — the sidecar contents
 * @param opts.static     baked-share mode: read-only (no annotate mode, editing,
 *                        or submit); highlights paint and comments sit behind a
 *                        "N comments" pill
 */
export function annotateSnippet(
  slug: string,
  annotationsJson: string,
  opts?: { static?: boolean; revision?: string },
): string {
  const staticMode = opts?.static === true;
  // Escape `<` so a `</script>` inside any comment/quote cannot close the tag.
  // The result is still valid JS (\u003c in a string/JSON literal), so hydration
  // parses correctly.
  const safeJson = annotationsJson.replace(/</g, '\\u003c');

  return `
<style>
[data-artifact-annotate] {
  all: initial; user-select: none;
  /* Derived defaults; boot JS sets --aa-bg/--aa-fg/--aa-accent on <html> and
     --aa-host-* for host tokens that exist (an element rule beats an inherited
     custom property, so the host value must come through var(), not override). */
  --aa-muted: var(--aa-host-muted, color-mix(in srgb, var(--aa-fg) 55%, var(--aa-bg)));
  --aa-border: var(--aa-host-border, color-mix(in srgb, var(--aa-fg) 18%, var(--aa-bg)));
  --aa-code-bg: var(--aa-host-code-bg, color-mix(in srgb, var(--aa-fg) 6%, var(--aa-bg)));
}
[data-artifact-annotate] *, [data-artifact-annotate] *::before, [data-artifact-annotate] *::after { box-sizing: border-box; }
[data-artifact-annotate] [hidden] { display: none !important; }
[data-artifact-annotate] textarea, [data-artifact-annotate] .comment, [data-artifact-annotate] .reply, [data-artifact-annotate] .feedback { user-select: text; }
[data-artifact-annotate] button, [data-artifact-annotate] textarea { font: inherit; }
[data-artifact-annotate] :is(button, a, summary):focus-visible { outline: 2px solid var(--aa-accent); outline-offset: 3px; }
[data-artifact-annotate] button:disabled { opacity: .45; cursor: default; }
[data-artifact-annotate] .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
[data-aa-pin-tab] { outline: 2px dashed var(--aa-accent); outline-offset: 4px; cursor: crosshair; }
[data-aa-pin-tab]:hover, [data-aa-pin-tab]:focus { outline-style: solid; }
::highlight(artifact-comment) {
  background-color: color-mix(in srgb, var(--aa-accent) 30%, transparent);
}
@keyframes aa-pop {
  from { opacity: 0; transform: scale(.96) translateY(-4px); }
  to { opacity: 1; transform: none; }
}
@keyframes aa-toast {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to { opacity: 1; transform: translateX(-50%); }
}
#artifact-ui {
  position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;
  display: flex; gap: 8px; align-items: center;
}
#artifact-ui.review-open { right: 416px; }
#artifact-ui.review-open #artifact-annotate-btn { display: none; }
body.aa-review-layout { padding-right: 400px; }
#artifact-annotate-btn {
  font: 600 13px/1 system-ui, sans-serif;
  background: var(--aa-accent); color: var(--aa-bg);
  border: none; border-radius: 999px; padding: 10px 16px; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.25);
  transition: transform .15s ease, box-shadow .15s ease;
}
#artifact-share-btn {
  font: 600 13px/1 system-ui, sans-serif;
  background: var(--aa-bg); color: var(--aa-fg);
  border: 1px solid var(--aa-border); border-radius: 999px; padding: 10px 16px; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.25);
  transition: transform .15s ease, box-shadow .15s ease;
}
#artifact-share-btn:hover { transform: translateY(-2px); box-shadow: 0 5px 14px rgba(0,0,0,.3); }
#artifact-share-menu {
  position: fixed; bottom: 64px; right: 20px; z-index: 2147483001; min-width: 220px;
  background: var(--aa-bg); color: var(--aa-fg);
  border: 1px solid var(--aa-border); border-radius: 10px; padding: 6px;
  box-shadow: 0 8px 24px rgba(0,0,0,.28);
  font: 13px system-ui, sans-serif; display: none;
  animation: aa-pop .16s ease;
}
#artifact-share-menu button {
  all: unset; display: block; width: 100%; box-sizing: border-box;
  padding: 8px 12px; border-radius: 6px; cursor: pointer;
  font: 13px system-ui, sans-serif; color: var(--aa-fg);
}
#artifact-share-menu button:hover { background: color-mix(in srgb, var(--aa-fg) 8%, transparent); }
@media print {
  #artifact-ui, #artifact-annotate-panel, #artifact-annotate-popover,
  #artifact-annotate-toast, #artifact-share-menu { display: none !important; }
  body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  body.aa-review-layout { padding-right: 0 !important; }
}
.aa-print-comments { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border, #ddd); }
.aa-print-comments h2 { font-size: 1.05rem; margin: 0 0 .6em; }
.aa-print-comments .item { margin-bottom: .9em; }
.aa-print-comments blockquote {
  margin: 0 0 .2em; padding: 2px 10px; font-style: italic;
  border-left: 3px solid var(--accent, #d67858); color: var(--muted, #888);
}
.aa-print-comments p { margin: 0; }
#artifact-annotate-btn:hover { transform: translateY(-2px); box-shadow: 0 5px 14px rgba(0,0,0,.3); }
#artifact-annotate-btn.active {
  outline: 2px solid var(--aa-fg);
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--aa-accent) 25%, transparent);
}
#artifact-annotate-btn .badge {
  display: inline-block; margin-left: 6px; min-width: 16px; padding: 0 4px;
  border-radius: 999px; background: var(--aa-bg); color: var(--aa-accent);
  font-size: 11px; text-align: center;
}
#artifact-annotate-panel {
  position: fixed; top: 16px; right: 16px; bottom: 16px; width: 380px; z-index: 2147483000;
  background: var(--aa-bg); color: var(--aa-fg);
  border: 1px solid var(--aa-border); border-radius: 16px; overflow: hidden;
  box-shadow: 0 12px 48px rgba(0,0,0,.18);
  font: 14px/1.55 system-ui, sans-serif; display: flex; flex-direction: column;
  visibility: hidden; transform: translateX(12px); opacity: 0;
  transition: transform .16s ease, opacity .16s ease, visibility .16s;
}
#artifact-annotate-panel.open { visibility: visible; transform: none; opacity: 1; }
/* ?panel=open share renders show the review, not the tooling */
#artifact-annotate-panel.sharemode .actions, #artifact-annotate-panel.sharemode .close, #artifact-annotate-panel.sharemode .compare { display: none; }
#artifact-annotate-panel header {
  display: flex; align-items: center; gap: 16px; flex: none;
  padding: 16px 20px; border-bottom: 1px solid var(--aa-border);
}
#artifact-annotate-panel header h2 { font: 650 18px/1.4 system-ui, sans-serif; margin: 0 auto 0 0; padding: 0; border: 0; color: inherit; }
#artifact-annotate-panel .close { border: 0; background: none; color: var(--aa-muted); font-size: 24px; padding: 0 4px; cursor: pointer; }
#artifact-annotate-panel .compare { font-size: 12px; color: var(--aa-muted); text-decoration: none; }
#artifact-annotate-panel .compare:hover { color: var(--aa-fg); text-decoration: underline; }
#artifact-annotate-panel .panel-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
#artifact-annotate-panel .list { padding: 0 20px 20px; }
#artifact-annotate-panel .hint { color: var(--aa-muted); font-size: 13px; line-height: 1.5; margin: 0 0 16px; }
#artifact-annotate-panel .list-heading { margin: 4px 0 12px; font: 600 12px/1.5 system-ui, sans-serif; color: var(--aa-muted); }
#artifact-annotate-panel .list-heading span { margin-left: 6px; }
#artifact-annotate-panel .item {
  border: 1px solid var(--aa-border); border-radius: 10px; padding: 14px; margin-bottom: 10px; overflow-wrap: anywhere;
}
#artifact-annotate-panel .item-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; font-size: 11px; }
#artifact-annotate-panel .intent-label { font-weight: 600; color: var(--aa-fg); }
#artifact-annotate-panel .item .quote {
  color: var(--aa-muted); font-size: 12px; margin-bottom: 10px; text-align: left; line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
#artifact-annotate-panel .item .stale { color: var(--aa-accent); }
#artifact-annotate-panel .item .actions { display: flex; gap: 14px; margin-top: 12px; }
#artifact-annotate-panel .reply { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--aa-border); white-space: pre-wrap; }
#artifact-annotate-panel .sent { border-top: 1px solid var(--aa-border); margin-top: 20px; padding-top: 16px; }
#artifact-annotate-panel .sent summary { color: var(--aa-muted); font-size: 13px; cursor: pointer; margin-bottom: 12px; }
#artifact-annotate-panel .empty { padding: 16px 8px 24px; text-align: center; color: var(--aa-muted); font-size: 13px; }
#artifact-annotate-panel .empty strong { font-weight: 500; color: var(--aa-fg); }
#artifact-annotate-panel .empty p { margin: 8px 0 0; }
#artifact-annotate-panel .item textarea {
  width: 100%; box-sizing: border-box; min-height: 50px; resize: vertical;
  font: 13px/1.5 system-ui, sans-serif; margin-top: 4px; padding: 6px 8px;
  background: var(--aa-code-bg); color: var(--aa-fg);
  border: 1px solid var(--aa-border); border-radius: 8px; outline: none;
}
#artifact-annotate-panel .item textarea:focus { border-color: var(--aa-accent); }
#artifact-annotate-panel button.link {
  background: none; border: none; color: var(--aa-muted); cursor: pointer;
  font-size: 12px; padding: 2px 0;
}
#artifact-annotate-panel button.link:hover { color: var(--aa-fg); text-decoration: underline; }
#artifact-annotate-panel footer { flex: none; padding: 16px 20px 20px; border-top: 1px solid var(--aa-border); }
#artifact-annotate-panel .send-status { font-size: 12px; color: var(--aa-muted); margin: 0 0 12px; }
#artifact-annotate-panel .pin.active { color: var(--aa-accent); }
#artifact-annotate-panel .reload-artifact { width: 100%; margin-bottom: 12px; padding: 8px; border: 1px solid var(--aa-border); background: var(--aa-code-bg); color: var(--aa-fg); border-radius: 8px; cursor: pointer; }
@media (max-width: 900px) {
  body.aa-review-layout { padding-right: 0; }
  #artifact-annotate-panel { top: auto; right: 8px; bottom: 8px; width: min(380px, calc(100vw - 16px)); max-height: 72dvh; }
  #artifact-ui.review-open { right: auto; left: 8px; }
}
@media (max-width: 500px) { #artifact-ui.review-open { display: none; } }
@media (prefers-reduced-motion: reduce) { #artifact-annotate-panel { transition: none; } [data-artifact-annotate] * { animation: none !important; } }
#artifact-annotate-panel .send {
  width: 100%; padding: 12px; border: none; border-radius: 9px; cursor: pointer;
  background: var(--aa-accent); color: var(--aa-bg); font: 600 14px system-ui, sans-serif;
}
#artifact-annotate-panel .send:disabled { opacity: .5; cursor: default; }
#artifact-annotate-popover { padding: 20px; color: var(--aa-fg); }
#artifact-annotate-popover .context-row { display: flex; align-items: baseline; gap: 8px; margin: 14px 0 8px; }
#artifact-annotate-popover .pop-quote { flex: 1; font-size: 12px; line-height: 1.5; color: var(--aa-muted); max-height: 54px; overflow: hidden; overflow-wrap: anywhere; }
#artifact-annotate-popover .intent { display: flex; padding: 3px; margin: 0; border: 1px solid var(--aa-border); border-radius: 9px; background: var(--aa-code-bg); min-width: 0; }
#artifact-annotate-popover .intent label { flex: 1; margin: 0; cursor: pointer; text-align: center; position: relative; }
#artifact-annotate-popover .intent input { position: absolute; width: 1px; height: 1px; opacity: 0; }
#artifact-annotate-popover .intent span { display: block; padding: 7px 4px; border-radius: 6px; font-size: 12px; color: var(--aa-muted); }
#artifact-annotate-popover .intent input:checked + span { background: var(--aa-bg); color: var(--aa-fg); box-shadow: 0 1px 4px rgba(0,0,0,.12); font-weight: 600; }
#artifact-annotate-popover .intent input:focus-visible + span { outline: 2px solid var(--aa-accent); outline-offset: 1px; }
#artifact-annotate-popover textarea {
  display: block; width: 100%; min-height: 112px; resize: vertical;
  font: 14px/1.6 system-ui, sans-serif; padding: 12px; outline: none;
  background: var(--aa-bg); color: var(--aa-fg);
  border: 1px solid var(--aa-border); border-radius: 8px;
}
#artifact-annotate-popover textarea:focus {
  border-color: var(--aa-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aa-accent) 22%, transparent);
}
#artifact-annotate-popover .preview { min-height: 112px; max-height: 240px; overflow: auto; padding: 12px; border: 1px solid var(--aa-border); border-radius: 8px; }
#artifact-annotate-popover .row { display: flex; align-items: center; gap: 14px; padding: 10px 0; }
#artifact-annotate-popover .secondary { margin-left: auto; font: 600 12px/1.5 system-ui, sans-serif; padding: 7px 12px; border: 1px solid var(--aa-border); border-radius: 7px; background: var(--aa-code-bg); color: var(--aa-fg); cursor: pointer; }
#artifact-annotate-popover .composer-help { display: flex; align-items: baseline; justify-content: space-between; color: var(--aa-muted); font-size: 11px; }
#artifact-annotate-popover .pin-hint { margin: 12px 0 0; color: var(--aa-accent); }
.md-preview p { margin: 0 0 6px; }
.md-preview p:last-child { margin-bottom: 0; }
.md-preview ul, .md-preview ol { margin: 0 0 6px; padding-left: 18px; }
.md-preview h1, .md-preview h2, .md-preview h3, .md-preview h4 { font-size: 13px; margin: 8px 0 4px; }
.md-preview code {
  background: var(--aa-code-bg); border: 1px solid var(--aa-border);
  border-radius: 4px; padding: 0 4px; font: 12px ui-monospace, monospace;
}
.md-preview pre {
  background: var(--aa-code-bg); border: 1px solid var(--aa-border);
  border-radius: 8px; padding: 8px; overflow: auto; margin: 0 0 6px;
}
.md-preview pre code { background: none; border: none; padding: 0; }
.md-preview blockquote {
  border-left: 3px solid var(--aa-border); margin: 0 0 6px;
  padding: 2px 8px; color: var(--aa-muted);
}
.md-preview a { color: var(--aa-accent); }
.md-preview img { max-width: 100%; }
#artifact-annotate-toast {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 2147483002;
  background: var(--aa-fg); color: var(--aa-bg); padding: 10px 16px; border-radius: 6px;
  font: 13px system-ui, sans-serif; display: none;
  animation: aa-toast .25s ease;
}
#artifact-annotate-panel .feedback {
  white-space: pre-wrap; font: 11px/1.4 ui-monospace, monospace;
  background: var(--aa-code-bg); border: 1px solid var(--aa-border);
  border-radius: 6px; padding: 8px; max-height: 200px; overflow: auto; margin-top: 8px;
}
</style>
<script>
(function () {
  var SLUG = ${JSON.stringify(slug)};
  var STATIC = ${staticMode ? 'true' : 'false'};
  var REVISION = ${JSON.stringify(opts?.revision ?? '')};
  var urlParams = new URLSearchParams(location.search);
  window.__ARTIFACT_ANNOTATIONS__ = ${safeJson};

  var state = {
    mode: "off",
    annotations: (window.__ARTIFACT_ANNOTATIONS__ || []).slice(),
    editing: null,
    pending: {},
    revision: REVISION,
    saving: Promise.resolve(),
    saveError: false,
    pinning: false,
    sending: false,
    conflict: false,
    pendingSaves: 0,
    baseline: (window.__ARTIFACT_ANNOTATIONS__ || []).map(clean),
  };
  // ?panel=open pins the panel open for share renders; render() must not stomp it.
  var panelPinned = false;
  var supportsHighlight = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

  // ── DOM scaffold ──────────────────────────────────────────────────────────
  var root = document.createElement("div");
  root.setAttribute("data-artifact-annotate", "1");
  document.body.appendChild(root);

  // ── palette ─────────────────────────────────────────────────────────────
  // Host pages may define all, some, or none of the artifact CSS tokens (a raw
  // full-doc artifact can define --bg/--fg/--accent and skip --code-bg, which
  // left per-property fallbacks internally inconsistent — light field, light
  // text). Derive one guaranteed-consistent palette instead: honor the host
  // tokens that exist, fall back to the page's computed body colors, guard
  // bg/fg contrast, and set --aa-* on <html> so even ::highlight resolves them.
  var htmlStyles = getComputedStyle(document.documentElement);
  var probe = document.createElement("span");
  root.appendChild(probe);
  function toRgb(v) { probe.style.color = v; return getComputedStyle(probe).color; }
  function lum(v) {
    var m = toRgb(v).match(/[\\d.]+/g);
    if (!m || m.length < 3) return 1;
    return (0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2]) / 255;
  }
  function tok(name) { return htmlStyles.getPropertyValue(name).trim(); }
  function isTransparent(c) { return !c || c === "transparent" || c === "rgba(0, 0, 0, 0)"; }

  var bgT = tok("--bg"), hostBg = !!bgT;
  if (!bgT) {
    bgT = getComputedStyle(document.body).backgroundColor;
    if (isTransparent(bgT)) bgT = htmlStyles.backgroundColor;
    if (isTransparent(bgT)) bgT = window.matchMedia("(prefers-color-scheme: dark)").matches ? "#171614" : "#ffffff";
  }
  var fgT = tok("--fg") || getComputedStyle(document.body).color || "#111111", hostFg = !!tok("--fg");
  if (Math.abs(lum(bgT) - lum(fgT)) < 0.25) { fgT = lum(bgT) < 0.5 ? "#e6e6e6" : "#111111"; hostFg = false; }

  // Keep valid host tokens live so reader theme changes also recolor the review UI.
  var host = document.documentElement.style;
  host.setProperty("--aa-bg", hostBg ? "var(--bg)" : bgT);
  host.setProperty("--aa-fg", hostFg ? "var(--fg)" : fgT);
  host.setProperty("--aa-accent", tok("--accent") ? "var(--accent)" : "#d67858");
  if (tok("--muted")) host.setProperty("--aa-host-muted", "var(--muted)");
  if (tok("--border")) host.setProperty("--aa-host-border", "var(--border)");
  if (tok("--code-bg")) host.setProperty("--aa-host-code-bg", "var(--code-bg)");

  var ui = document.createElement("div");
  ui.id = "artifact-ui";
  root.appendChild(ui);

  // Share control: every live (non-static) artifact page gets it. Routes through
  // POST /api/share so gist uses the host's gh auth and copy uses the system
  // clipboard — no browser permission prompts.
  var shareBtn = null, shareMenu = null;
  if (!STATIC) {
    shareBtn = document.createElement("button");
    shareBtn.id = "artifact-share-btn";
    shareBtn.textContent = "Share";
    ui.appendChild(shareBtn);

    shareMenu = document.createElement("div");
    shareMenu.id = "artifact-share-menu";
    root.appendChild(shareMenu);
  }

  var btn = document.createElement("button");
  btn.id = "artifact-annotate-btn";
  ui.appendChild(btn);

  var panel = document.createElement("div");
  panel.id = "artifact-annotate-panel";
  panel.setAttribute("aria-label", "Artifact review");
  panel.innerHTML =
    '<header><h2>Review</h2><a class="compare" href="/api/revision?slug=' + encodeURIComponent(SLUG) + '" target="_blank" rel="noopener">View changes</a><button type="button" class="close" data-close aria-label="Close review">×</button></header>' +
    '<div class="panel-body"><div class="composer-slot"></div><div class="list"></div></div>' +
    '<footer><p class="send-status" role="status"></p><button type="button" class="send">Send review</button></footer>';
  root.appendChild(panel);

  var popover = document.createElement("div");
  popover.id = "artifact-annotate-popover";
  popover.innerHTML =
    '<p class="hint">Write feedback here, or select text in the document.</p>' +
    '<fieldset class="intent"><legend class="sr-only">Feedback type</legend>' +
    '<label><input type="radio" name="artifact-intent" value="comment" checked><span>Comment</span></label>' +
    '<label><input type="radio" name="artifact-intent" value="question"><span>Question</span></label>' +
    '<label><input type="radio" name="artifact-intent" value="keep"><span>Keep this</span></label></fieldset>' +
    '<div class="context-row"><span class="pop-quote">Whole document</span><button type="button" class="link general" hidden>Clear selection</button></div>' +
    '<textarea aria-label="Comment" placeholder="What should change?"></textarea>' +
    '<div class="preview md-preview" style="display:none"></div>' +
    '<div class="row"><button type="button" class="link" data-tab="preview">Preview</button><button type="button" class="link" data-cancel>Clear</button><button type="button" class="secondary" data-add disabled>Add to review</button></div>' +
    '<div class="composer-help"><span>Markdown supported</span><button type="button" class="link pin" aria-pressed="false">Pin a visual</button></div>' +
    '<p class="pin-hint hint" role="status" hidden>Click a highlighted visual in the document. Esc cancels.</p>';
  panel.querySelector(".composer-slot").appendChild(popover);

  var toast = document.createElement("div");
  toast.id = "artifact-annotate-toast";
  toast.setAttribute("role", "status");
  root.appendChild(toast);

  var listEl = panel.querySelector(".list");
  var sendBtn = panel.querySelector(".send");
  var popTextarea = popover.querySelector("textarea");
  var popPreview = popover.querySelector(".preview");
  var popQuote = popover.querySelector(".pop-quote");
  var addBtn = popover.querySelector("[data-add]");

  // ── helpers ─────────────────────────────────────────────────────────────
  function norm(s) { return String(s == null ? "" : s).replace(/\\s+/g, " ").trim(); }
  function newId() { return Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e4); }
  function showToast(msg) {
    toast.textContent = msg; toast.style.display = "block";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.style.display = "none"; }, 2600);
  }

  function setMode(m) {
    state.mode = m;
    btn.classList.toggle("active", m === "annotate");
    if (m === "off") setPinning(false);
    render();
    if (m === "off") btn.focus();
    else (STATIC ? panel.querySelector("[data-close]") : panel.querySelector("[data-edittext]") || popTextarea).focus();
  }

  // ── persistence ───────────────────────────────────────────────────────────
  function clean(a) {
    var out = { id: a.id, comment: a.comment, createdAt: a.createdAt };
    ["quote", "element", "intent", "decisionId", "decisionValues", "sentAt", "reply"].forEach(function (k) {
      if (a[k] !== undefined) out[k] = a[k];
    });
    return out;
  }
  // Each request snapshots state when it starts, rather than when queued. A failed
  // save is never replayed accidentally, and drafts remain editable in this tab.
  function persist() {
    if (STATIC) return Promise.resolve();
    state.pendingSaves++;
    state.saving = state.saving.then(function () {
      if (state.conflict) throw new Error("conflict");
      var payload = state.annotations.map(clean);
      return fetch("/api/annotations", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: SLUG, annotations: payload, revision: state.revision || undefined }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r:r, b:b }; }); })
        .then(function (x) {
          if (x.r.status === 409) { state.conflict = true; state.saveError = true; showToast("Review conflict. Copy your unsaved feedback before reloading."); throw new Error("conflict"); }
          if (!x.r.ok) throw new Error("save failed (" + x.r.status + ")");
          state.saveError = false;
          if (Array.isArray(x.b.annotations)) mergeServer(x.b.annotations, x.b.revision, payload);
        });
    }).catch(function (e) { state.saveError = true; if (e.message !== "conflict") showToast("Could not reach the server. Drafts are kept."); }).finally(function () { state.pendingSaves--; updateSendState(); });
    return state.saving;
  }
  function mergeServer(server, revision, baseline) {
    var base = new Map((baseline || state.baseline).map(function (a) { return [a.id, clean(a)]; }));
    var local = new Map(state.annotations.map(function (a) { return [a.id, a]; }));
    var remote = new Map(server.map(function (a) { return [a.id, a]; }));
    var ids = new Set(Array.from(local.keys()).concat(Array.from(remote.keys()), Array.from(base.keys())));
    var merged = [], conflict = false;
    function same(a, b) { return JSON.stringify(a && clean(a)) === JSON.stringify(b && clean(b)); }
    ids.forEach(function (id) {
      var l = local.get(id), r = remote.get(id), b = base.get(id), value;
      if (r && r.sentAt) value = r;
      else if (same(l, b)) value = r;
      else if (same(r, b) || same(l, r)) value = l;
      else { conflict = true; value = l; }
      if (value) merged.push(value);
    });
    if (conflict) { state.conflict = true; state.saveError = true; showToast("Review conflict. Copy your unsaved feedback before reloading."); return; }
    state.annotations = merged; state.baseline = server.map(clean);
    if (revision) state.revision = revision;
    reHighlightAll(); render();
  }

  // ── anchoring / highlights ──────────────────────────────────────────────
  // Text flow over the visible page, EXCLUDING our own UI (the panel lists
  // quotes — an unfiltered walk would anchor comments into the panel itself)
  // and style/script text. Seam rule mirrors the server's tag stripping in
  // feedback.ts: a boundary between two text nodes contributes a space iff the
  // nodes live in different block-level subtrees (inline markup joins directly).
  var INLINE_TAGS = { A:1, ABBR:1, B:1, BDI:1, BDO:1, CITE:1, CODE:1, DATA:1, DEL:1, EM:1, I:1, INS:1,
    KBD:1, MARK:1, Q:1, S:1, SMALL:1, SPAN:1, STRONG:1, SUB:1, SUP:1, TIME:1, U:1, WBR:1 };

  function blockOf(el) {
    while (el && el !== document.body && INLINE_TAGS[el.tagName]) el = el.parentElement;
    return el || document.body;
  }

  function textNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (el.closest("[data-artifact-annotate]")) return NodeFilter.FILTER_REJECT;
        var tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var out = [], n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // Joined visible text plus, per node, its start offset in that text.
  function flowParts() {
    var nodes = textNodes();
    var parts = [];
    var text = "";
    for (var i = 0; i < nodes.length; i++) {
      if (i > 0 && blockOf(nodes[i - 1].parentElement) !== blockOf(nodes[i].parentElement)) text += " ";
      parts.push({ node: nodes[i], start: text.length });
      text += nodes[i].textContent;
    }
    return { text: text, parts: parts };
  }

  function contextAround(range) {
    try {
      var flow = flowParts();
      var sp = null, ep = null;
      for (var i = 0; i < flow.parts.length; i++) {
        if (flow.parts[i].node === range.startContainer) sp = flow.parts[i];
        if (flow.parts[i].node === range.endContainer) ep = flow.parts[i];
      }
      if (!sp || !ep) return { prefix: "", suffix: "" };
      var before = flow.text.slice(0, sp.start) + range.startContainer.textContent.slice(0, range.startOffset);
      var after = range.endContainer.textContent.slice(range.endOffset) +
        flow.text.slice(ep.start + range.endContainer.textContent.length);
      return { prefix: norm(before).slice(-60), suffix: norm(after).slice(0, 60) };
    } catch (_) { return { prefix: "", suffix: "" }; }
  }

  // Find the quote in the visible flow and map it back to a DOM Range.
  // Whitespace-flexible: the normalized target spans element seams.
  function findRange(quote) {
    var target = norm(quote.exact);
    if (!target) return null;
    var flow = flowParts();
    var re = new RegExp(target.split(" ").map(function (w) { return w.replace(/[^\\w]/g, "\\\\$&"); }).join("\\\\s+"), "g");
    var hits = Array.from(flow.text.matchAll(re));
    var m = hits.length === 1 ? hits[0] : hits.find(function (hit) {
      return (!norm(quote.prefix) || norm(flow.text.slice(0, hit.index)).endsWith(norm(quote.prefix))) &&
        (!norm(quote.suffix) || norm(flow.text.slice(hit.index + hit[0].length)).startsWith(norm(quote.suffix)));
    });
    if (!m) return null;
    var startIdx = m.index;
    var endIdx = m.index + m[0].length;
    var sp = null, ep = null;
    for (var i = 0; i < flow.parts.length; i++) {
      var p = flow.parts[i];
      var end = p.start + p.node.textContent.length;
      if (sp === null && p.start <= startIdx && startIdx < end) sp = p;
      if (p.start < endIdx && endIdx <= end) ep = p;
    }
    if (!sp || !ep) return null;
    try {
      var r = document.createRange();
      r.setStart(sp.node, startIdx - sp.start);
      r.setEnd(ep.node, endIdx - ep.start);
      return r;
    } catch (_) { return null; }
  }

  function reHighlightAll() {
    var hl = supportsHighlight ? new Highlight() : null;
    state.annotations.forEach(function (a) {
      var r = a.quote ? findRange(a.quote) : null;
      a._stale = a.element ? !findElement(a.element) : !!a.quote && !r;
      if (r && hl) hl.add(r);
    });
    if (hl) CSS.highlights.set("artifact-comment", hl);
  }

  // ── composer ────────────────────────────────────────────────────────────
  function resetComposer() {
    state.pending = {}; popTextarea.value = "";
    popQuote.textContent = "Whole document";
    panel.querySelector(".general").hidden = true;
    popover.querySelector('input[value="comment"]').checked = true;
    updateIntent(); setTab("write"); updateSendState();
  }
  function updateIntent() {
    var intent = popover.querySelector('input[name="artifact-intent"]:checked').value;
    popTextarea.placeholder = intent === "question" ? "What would you like explained?" : intent === "keep" ? "What should stay unchanged?" : "What should change?";
  }
  function updateSendState() {
    var typed = !!popTextarea.value.trim();
    var count = state.annotations.filter(function (a) { return !a.sentAt; }).length + (typed ? 1 : 0);
    sendBtn.disabled = state.sending || count === 0 || state.editing !== null;
    sendBtn.textContent = state.sending ? "Sending…" : "Send review" + (count ? " (" + count + ")" : "");
    addBtn.disabled = state.sending || !typed || state.editing !== null;
    panel.querySelector(".send-status").textContent = state.conflict ? "Another tab changed this review. Copy your feedback before reloading." : state.saveError ? "Could not save. Keep this tab open and try sending again." : state.editing !== null ? "Save or cancel your edit before sending." : state.sending ? "Sending your feedback to the agent…" : "Nothing is sent until you send this review.";
  }

  var previewTimer = null;
  function setTab(which) {
    var preview = which === "preview", toggle = popover.querySelector("[data-tab]");
    toggle.setAttribute("data-tab", preview ? "write" : "preview");
    toggle.textContent = preview ? "Write" : "Preview";
    popTextarea.style.display = preview ? "none" : "";
    popPreview.style.display = preview ? "block" : "none";
    if (preview) renderPreview();
  }

  function renderPreview() {
    fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: popTextarea.value }),
    }).then(function (r) { return r.json(); })
      .then(function (b) {
        if (popPreview.style.display !== "none") popPreview.innerHTML = typeof b.html === "string" ? b.html : "";
      })
      .catch(function () {});
  }

  // Render a panel comment's markdown once; re-render on cache miss only.
  function renderCommentHtml(a) {
    if (a._html !== undefined && a._html !== null) return;
    if (a._html === null) return; // in flight
    a._html = null;
    fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: a.comment }),
    }).then(function (r) { return r.json(); })
      .then(function (b) { a._html = typeof b.html === "string" ? b.html : ""; render(); })
      .catch(function () { a._html = undefined; });
  }

  function addPending() {
    var comment = String(popTextarea.value || "").trim();
    if (state.sending || state.editing !== null || !comment || !state.pending) return;
    var a = { id: newId(), comment: comment, createdAt: new Date().toISOString(), intent: popover.querySelector('input[name="artifact-intent"]:checked').value };
    if (state.pending.exact) {
      a.quote = { exact: state.pending.exact };
      if (state.pending.prefix) a.quote.prefix = state.pending.prefix;
      if (state.pending.suffix) a.quote.suffix = state.pending.suffix;
    }
    if (state.pending.element) a.element = state.pending.element;
    state.annotations.push(a);
    state.editing = null;
    resetComposer(); reHighlightAll(); render(); persist();
  }
  function openComposer(pending, label) {
    if (popTextarea.value.trim() && pending && (pending.exact || pending.element)) {
      showToast("Add or clear your comment before choosing a passage or visual."); return;
    }
    state.pending = pending || {};
    popQuote.textContent = label || "Whole document";
    panel.querySelector(".general").hidden = !state.pending.exact && !state.pending.element;
    setTab("write"); popTextarea.focus();
  }
  function elementSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.hasAttribute("data-artifact-anchor")) return "[data-artifact-anchor=" + JSON.stringify(el.getAttribute("data-artifact-anchor")) + "]";
    var bits = [];
    while (el && el !== document.body && bits.length < 5) {
      var n = el.tagName.toLowerCase(), siblings = el.parentElement ? Array.prototype.filter.call(el.parentElement.children, function (x) { return x.tagName === el.tagName; }) : [];
      bits.unshift(n + (siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")" : "")); el = el.parentElement;
    }
    return bits.join(" > ");
  }
  function findElement(anchor) {
    try { var matches = document.querySelectorAll(anchor.selector); return matches.length === 1 && !root.contains(matches[0]) ? matches[0] : null; } catch (_) { return null; }
  }
  function pinTarget(el) {
    return el && el.closest && !root.contains(el) && el.closest("img,svg,figure,table,canvas,[data-artifact-anchor]");
  }
  function setPinning(active) {
    state.pinning = active;
    var pin = panel.querySelector(".pin");
    pin.classList.toggle("active", active);
    pin.setAttribute("aria-pressed", String(active));
    pin.textContent = active ? "Cancel pin" : "Pin a visual";
    panel.querySelector(".pin-hint").hidden = !active;
    var targets = document.querySelectorAll("img,svg,figure,table,canvas,[data-artifact-anchor]");
    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      if (root.contains(el)) continue;
      if (active && !el.hasAttribute("data-aa-pin-tab")) {
        el.setAttribute("data-aa-pin-tab", el.hasAttribute("tabindex") ? el.getAttribute("tabindex") : "absent"); el.setAttribute("tabindex", "0");
      } else if (!active && el.hasAttribute("data-aa-pin-tab")) {
        var prior = el.getAttribute("data-aa-pin-tab");
        if (prior === "absent") el.removeAttribute("tabindex"); else el.setAttribute("tabindex", prior);
        el.removeAttribute("data-aa-pin-tab");
      }
    }
  }

  function onSelect() {
    if (STATIC || state.sending || state.pinning || state.mode !== "annotate") return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var exact = sel.toString();
    if (!norm(exact)) return;
    var range = sel.getRangeAt(0);
    if (root.contains(range.startContainer) || root.contains(range.endContainer)) return;
    var ctx = contextAround(range);
    var q = norm(exact);
    if (q.length > 140) q = q.slice(0, 137) + "…";
    openComposer({ exact: exact, prefix: ctx.prefix, suffix: ctx.suffix }, '"' + q + '"');
  }

  // ── render ────────────────────────────────────────────────────────────────
  function render() {
    var drafts = state.annotations.filter(function (a) { return !a.sentAt; });
    var sent = state.annotations.filter(function (a) { return a.sentAt; });
    btn.innerHTML = STATIC ? state.annotations.length + (state.annotations.length === 1 ? " comment" : " comments") : "Review" + badge(drafts.length);
    var isOpen = panelPinned || state.mode === "annotate";
    panel.classList.toggle("open", isOpen);
    btn.setAttribute("aria-expanded", String(isOpen));
    ui.classList.toggle("review-open", isOpen);
    document.body.classList.toggle("aa-review-layout", isOpen && !!document.querySelector("style[data-base]"));
    function item(a) {
      var i = state.annotations.indexOf(a), anchor = a.quote ? '"' + escapeHtml(a.quote.exact) + '"' : a.element ? "Visual: " + escapeHtml(a.element.label || a.element.selector) : "Whole document";
      var intent = '<span class="intent-label">' + escapeHtml(a.intent === "keep" ? "Keep this" : a.intent === "question" ? "Question" : a.intent === "decision" ? "Decision" : "Comment") + '</span>';
      var body = state.editing === i ? '<textarea aria-label="Edit comment" data-edittext>' + escapeHtml(a.comment) + '</textarea><div class="actions"><button type="button" class="link" data-editsave="' + i + '">Save</button><button type="button" class="link" data-editcancel>Cancel</button></div>' : '<div class="comment md-preview">' + (a._html || escapeHtml(a.comment)) + '</div>';
      if (!STATIC && !a.sentAt && state.editing !== i) body += '<div class="actions"><button type="button" class="link" data-edit="' + i + '">Edit</button><button type="button" class="link" data-del="' + i + '">Delete</button></div>';
      if (a.sentAt && a.intent === "question") body += '<div class="reply">' + escapeHtml(a.reply ? "Agent: " + a.reply : "Waiting for the agent’s answer") + '</div>';
      var location = a.quote || a.element ? '<button type="button" class="quote link" data-scroll="' + i + '">' + anchor + '</button>' : '<div class="quote">' + anchor + '</div>';
      return '<div class="item" data-i="' + i + '"><div class="item-meta">' + intent + (a._stale ? '<span class="stale">Original content changed</span>' : '') + '</div>' + location + body + '</div>';
    }
    var sentOpen = !!listEl.querySelector(".sent[open]") || STATIC || urlParams.has("panel");
    var editInput = listEl.querySelector("[data-edittext]");
    var editValue = editInput ? editInput.value : null;
    var editFocused = editInput && document.activeElement === editInput;
    var sentHtml = sent.length ? '<details class="sent"' + (sentOpen ? ' open' : '') + '><summary>Sent feedback (' + sent.length + ')</summary>' + sent.map(item).join("") + '</details>' : "";
    listEl.innerHTML = (drafts.length ? '<h3 class="list-heading">Ready to send <span>' + drafts.length + '</span></h3>' + drafts.map(item).join("") : sent.length ? '' : '<div class="empty"><strong>Your review starts here</strong><p>Add several comments, or write one and send it directly.</p></div>') + sentHtml;
    if (editValue !== null && listEl.querySelector("[data-edittext]")) { var restored = listEl.querySelector("[data-edittext]"); restored.value = editValue; if (editFocused) restored.focus(); }
    updateSendState();
    popover.querySelectorAll("input,textarea,button").forEach(function (control) { if (control !== addBtn) control.disabled = STATIC || state.sending; });
    document.querySelectorAll('fieldset[data-artifact-decision] input').forEach(function (input) { input.disabled = STATIC || state.sending; });
    restoreDecisions();
    state.annotations.forEach(function (a) { if (!STATIC) renderCommentHtml(a); });
  }

  function badge(n) { return n > 0 ? ' <span class="badge">' + n + "</span>" : ""; }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── submit ─────────────────────────────────────────────────────────────
  function send() {
    if (STATIC || state.sending || state.editing !== null) return;
    if (popTextarea.value.trim()) addPending();
    if (!state.annotations.some(function (a) { return !a.sentAt; })) return;
    state.sending = true;
    render();
    state.saving = persist().then(function () {
      if (state.saveError) { sendBtn.disabled = false; return Promise.reject(new Error("save failed")); }
      return fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: SLUG, revision: state.revision || undefined }),
    }); }).then(function (r) {
      return r.json().then(function (body) { return { status: r.status, body: body }; });
    }).then(function (res) {
      if (res.status === 200 && res.body.delivered) {
        state.annotations = Array.isArray(res.body.annotations) ? res.body.annotations : state.annotations.map(function (a) { if (!a.sentAt) a.sentAt = new Date().toISOString(); return a; });
        if (res.body.revision) state.revision = res.body.revision;
        state.baseline = state.annotations.map(clean);
        reHighlightAll(); render(); showToast("Sent to the agent");
      } else if (res.status === 503 && res.body.feedback) {
        showFeedbackFallback(res.body.feedback);
        sendBtn.disabled = state.annotations.length === 0;
      } else {
        showToast(res.body && res.body.error ? res.body.error : "Send failed");
        sendBtn.disabled = state.annotations.length === 0;
      }
    }).catch(function () {
      if (!state.saveError) showToast("Server unreachable — comments kept in this tab.");
      sendBtn.disabled = state.annotations.filter(function (a) { return !a.sentAt; }).length === 0;
    }).finally(function () { state.sending = false; render(); });
  }

  function showFeedbackFallback(feedback) {
    // Lives in the footer, not listEl — render() rewrites listEl and would wipe it.
    var footerEl = panel.querySelector("footer");
    var old = footerEl.querySelectorAll(".feedback, .copy-feedback");
    for (var k = 0; k < old.length; k++) old[k].remove();
    var box = document.createElement("div");
    box.className = "feedback";
    box.textContent = feedback;
    var copy = document.createElement("button");
    copy.className = "send copy-feedback";
    copy.style.marginTop = "8px";
    copy.textContent = "Copy feedback";
    copy.addEventListener("click", function () {
      if (navigator.clipboard) navigator.clipboard.writeText(feedback);
      showToast("Copied");
    });
    footerEl.insertBefore(copy, sendBtn);
    footerEl.insertBefore(box, copy);
    showToast("No live session — copy the feedback instead.");
  }

  // ── events ─────────────────────────────────────────────────────────────
  btn.addEventListener("click", function () {
    panelPinned = false;
    setMode(state.mode === "annotate" ? "off" : "annotate");
  });
  panel.addEventListener("click", function (e) {
    var t = e.target;
    if (state.sending) return;
    if (t.hasAttribute("data-close")) { panelPinned = false; setMode("off"); btn.focus(); return; }
    if (t.classList.contains("general") && !t.classList.contains("reload-artifact")) { openComposer({}); return; }
    if (t.classList.contains("pin")) { setPinning(!state.pinning); showToast(state.pinning ? "Click or press Enter on an element to pin it" : "Pinning cancelled"); return; }
    var scroll = t.getAttribute("data-scroll");
    if (scroll != null) { var a0 = state.annotations[parseInt(scroll, 10)], target = a0 && (a0.element ? findElement(a0.element) : a0.quote && findRange(a0.quote)); if (target) { if (target.scrollIntoView) target.scrollIntoView({ behavior:"smooth", block:"center" }); else target.startContainer.parentElement.scrollIntoView({ behavior:"smooth", block:"center" }); } else showToast("Anchor is no longer in this artifact."); return; }
    var del = t.getAttribute("data-del");
    if (del != null) {
      state.annotations.splice(parseInt(del, 10), 1);
      state.editing = null;
      reHighlightAll(); render(); persist();
      return;
    }
    var edit = t.getAttribute("data-edit");
    if (edit != null) {
      state.editing = parseInt(edit, 10);
      render();
      return;
    }
    if (t.hasAttribute("data-editcancel")) {
      state.editing = null;
      render();
      return;
    }
    var save = t.getAttribute("data-editsave");
    if (save != null) {
      var i = parseInt(save, 10);
      var ta = panel.querySelector("[data-edittext]");
      var comment = ta ? String(ta.value).trim() : "";
      if (comment && state.annotations[i]) {
        state.annotations[i].comment = comment;
        state.annotations[i]._html = undefined;
        persist();
      }
      state.editing = null;
      render();
    }
  });
  sendBtn.addEventListener("click", send);
  function choosePin(target) {
    var el = pinTarget(target);
    if (!state.pinning || !el) return false;
    setPinning(false);
    var label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("data-artifact-anchor") || el.tagName.toLowerCase();
    openComposer({ element: { selector: elementSelector(el), label: label } }, "Pinned: " + label);
    return true;
  }
  document.addEventListener("click", function (e) { if (state.pinning && choosePin(e.target)) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener("keydown", function (e) {
    if (state.pinning && (e.key === "Enter" || e.key === " ") && choosePin(e.target)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener("mouseup", function (e) { if (!root.contains(e.target)) setTimeout(onSelect, 0); });
  document.addEventListener("keyup", function (e) { if (e.shiftKey && !root.contains(e.target)) onSelect(); });
  popover.addEventListener("click", function (e) {
    var t = e.target;
    if (state.sending) return;
    if (t.hasAttribute("data-cancel")) { resetComposer(); return; }
    if (t.hasAttribute("data-add")) { addPending(); return; }
    var tab = t.getAttribute("data-tab");
    if (tab) setTab(tab);
  });
  popover.addEventListener("change", updateIntent);
  popTextarea.addEventListener("input", function () {
    updateSendState();
    if (popPreview.style.display === "none") return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 200);
  });
  popTextarea.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); addPending(); }
  });
  if (shareBtn && shareMenu) {
    shareBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (shareMenu.style.display === "block") { shareMenu.style.display = "none"; return; }
      var n = state.annotations.length;
      var withN = n ? " — with " + n + (n === 1 ? " comment" : " comments") : "";
      shareMenu.innerHTML =
        '<button data-share="image">Copy image' + withN + '</button>' +
        '<button data-share="pdf">Copy PDF' + withN + '</button>' +
        '<button data-share="copy">Copy file' + withN + '</button>' +
        '<button data-share="gist">Create gist link</button>';
      shareMenu.style.display = "block";
    });
    shareMenu.addEventListener("click", function (e) {
      var m = e.target.getAttribute("data-share");
      if (!m) return;
      shareMenu.style.display = "none";
      persist().then(function () {
        if (state.saveError) throw new Error("save failed");
        return fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: SLUG, method: m }),
      }); }).then(function (r) { return r.json(); })
        .then(function (b) {
          if (!b.ok) { showToast(b.error || "Share failed"); return; }
          if (b.url) { showToast("Gist created — link copied"); window.open(b.url, "_blank"); }
          else if (b.path) { showToast(b.copied ? "On your clipboard — paste it anywhere" : "Written to " + b.path); }
          else showToast("Copied " + Math.max(1, Math.round((b.bytes || 0) / 1024)) + " KB of HTML — paste it anywhere");
        })
        .catch(function () { showToast("Share failed — server unreachable"); });
    });
    document.addEventListener("click", function () { shareMenu.style.display = "none"; });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (shareMenu && shareMenu.style.display === "block") { shareMenu.style.display = "none"; return; }
    if (state.pinning) { setPinning(false); return; }
    if (state.editing != null) { state.editing = null; render(); return; }
    if (state.mode === "annotate") setMode("off");
  });

  // Decisions are ordinary draft annotations. The most recent draft or sent
  // record restores a fieldset, but merely observing authored defaults never writes.
  function decisionAnnotation(fs) {
    var id = fs.getAttribute("data-artifact-decision"), legend = fs.querySelector("legend");
    var inputs = fs.querySelectorAll('input[type="radio"],input[type="checkbox"]'), values = [], labels = [];
    for (var i = 0; i < inputs.length; i++) if (inputs[i].checked) { values.push(inputs[i].value); var l = inputs[i].closest("label"); labels.push(l ? norm(l.textContent) : inputs[i].value); }
    var old = state.annotations.filter(function (a) { return !a.sentAt && a.intent === "decision" && a.decisionId === id; })[0];
    var hasSent = state.annotations.some(function (a) { return a.sentAt && a.intent === "decision" && a.decisionId === id; });
    if (!values.length && !hasSent) { if (old) { state.annotations.splice(state.annotations.indexOf(old), 1); persist(); render(); } return; }
    var comment = (legend ? norm(legend.textContent) : "Decision") + ": " + (values.length ? labels.join(", ") + " (" + values.join(", ") + ")" : "None selected");
    if (old) { old.comment = comment; old.decisionValues = values; old._html = undefined; } else state.annotations.push({ id:newId(), comment:comment, createdAt:new Date().toISOString(), intent:"decision", decisionId:id, decisionValues:values });
    persist(); render();
  }
  function restoreDecisions() {
    document.querySelectorAll("fieldset[data-artifact-decision]").forEach(function (fs) {
      var matching = state.annotations.filter(function (a) { return a.intent === "decision" && a.decisionId === fs.getAttribute("data-artifact-decision"); });
      var drafts = matching.filter(function (a) { return !a.sentAt; });
      var latest = (drafts.length ? drafts : matching).slice(-1)[0];
      fs.querySelectorAll('input[type="radio"],input[type="checkbox"]').forEach(function (input) { input.checked = !!latest && Array.isArray(latest.decisionValues) && latest.decisionValues.indexOf(input.value) !== -1; });
    });
  }
  var fieldsets = document.querySelectorAll("fieldset[data-artifact-decision]");
  for (var fi = 0; fi < fieldsets.length; fi++) {
    (function (fs) {
      var id = fs.getAttribute("data-artifact-decision"), matching = state.annotations.filter(function (a) { return a.intent === "decision" && a.decisionId === id; }), drafts = matching.filter(function(a) { return !a.sentAt; }), latest = (drafts.length ? drafts : matching)[(drafts.length ? drafts : matching).length - 1];
      if (latest && Array.isArray(latest.decisionValues)) { var ins = fs.querySelectorAll('input[type="radio"],input[type="checkbox"]'); for (var j=0;j<ins.length;j++) ins[j].checked = latest.decisionValues.indexOf(ins[j].value) !== -1; }
      if (STATIC) { var all = fs.querySelectorAll("input"); for (var k=0;k<all.length;k++) all[k].disabled = true; }
      else fs.addEventListener("change", function () { decisionAnnotation(fs); });
    })(fieldsets[fi]);
  }
  if (!STATIC && typeof EventSource !== "undefined") {
    var events = new EventSource("/events");
    events.addEventListener("annotations", function (e) {
      if (e.data !== SLUG) return;
      state.saving = state.saving.then(function () {
        return fetch("/api/annotations?slug=" + encodeURIComponent(SLUG)).then(function (r) { if (!r.ok) throw new Error("refresh failed"); return r.json(); }).then(function (b) {
          if (Array.isArray(b.annotations)) mergeServer(b.annotations, b.revision);
        });
      }).catch(function () { showToast("Could not refresh answers. Your drafts are unchanged."); });
    });
  }
  function hasUnsavedWork() { return state.sending || state.pendingSaves > 0 || state.saveError || state.editing !== null || (state.pending && popTextarea.value.trim()); }
  if (!STATIC) {
    window.addEventListener("beforeunload", function (e) { if (hasUnsavedWork()) { e.preventDefault(); e.returnValue = ""; } });
    window.addEventListener("artifact:before-reload", function (e) {
      if (!hasUnsavedWork()) return;
      e.preventDefault();
      var reload = panel.querySelector(".reload-artifact");
      if (!reload) {
        reload = document.createElement("button"); reload.type = "button"; reload.className = "general reload-artifact";
        reload.textContent = "Artifact updated. Reload when ready";
        reload.addEventListener("click", function () { if (!hasUnsavedWork() || window.confirm("Reload and discard unsaved feedback?")) location.reload(); });
        panel.querySelector("footer").prepend(reload);
      }
      showToast("Artifact updated. Finish saving your feedback before reloading.");
    });
  }
  // ── boot ────────────────────────────────────────────────────────────────
  btn.setAttribute("aria-controls", panel.id);
  if (STATIC) { panel.querySelector("footer").style.display = "none"; panel.querySelector(".compare").style.display = "none"; popover.hidden = true; }
  reHighlightAll();
  render();

  // Share-render modes: ?panel=open shows the comments panel (image shares);
  // ?print=1 appends a plain comments section for print/PDF (fixed UI is
  // hidden by the @media print rules above). Panel mode is for screenshots: no
  // slide-in transition (a headless shot fires mid-animation) and no buttons.
  if (urlParams.has("panel") && state.annotations.length > 0) {
    panelPinned = true;
    panel.style.transition = "none";
    panel.classList.add("open", "sharemode");
    popover.hidden = true;
    render();
    panel.querySelector("footer").style.display = "none";
    ui.style.display = "none";
  }
  if (urlParams.has("print") && state.annotations.length > 0) {
    var printSection = document.createElement("section");
    printSection.className = "aa-print-comments";
    var printH = document.createElement("h2");
    printH.textContent = "Review comments (" + state.annotations.length + ")";
    printSection.appendChild(printH);
    state.annotations.forEach(function (a) {
      var item = document.createElement("div");
      item.className = "item";
      var bq = document.createElement("blockquote");
      bq.textContent = a.quote ? '"' + a.quote.exact + '"' : (a.element ? "Pinned: " + (a.element.label || a.element.selector) : "Whole artifact");
      var p = document.createElement("p");
      p.textContent = (a.intent && a.intent !== "comment" ? "[" + a.intent + "] " : "") + a.comment + (a.sentAt ? " (sent)" : "") + (a.reply ? "\\nReply: " + a.reply : "");
      item.appendChild(bq); item.appendChild(p);
      printSection.appendChild(item);
    });
    var artFooter = document.querySelector(".artifact-footer");
    if (artFooter && artFooter.parentElement) artFooter.parentElement.insertBefore(printSection, artFooter);
    else document.body.appendChild(printSection);
  }
})();
</script>`;
}
