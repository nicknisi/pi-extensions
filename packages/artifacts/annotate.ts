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
  opts?: { static?: boolean },
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
export function annotateSnippet(slug: string, annotationsJson: string, opts?: { static?: boolean }): string {
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
[data-artifact-annotate] textarea { user-select: text; }
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
  position: fixed; top: 0; right: 0; bottom: 0; width: 320px; z-index: 2147483000;
  background: var(--aa-bg); color: var(--aa-fg);
  border-left: 1px solid var(--aa-border);
  box-shadow: -2px 0 12px rgba(0,0,0,.15);
  font: 14px/1.45 system-ui, sans-serif; display: flex; flex-direction: column;
  visibility: hidden; transform: translateX(30px); opacity: 0;
  transition: transform .22s ease, opacity .22s ease, visibility .22s;
}
#artifact-annotate-panel.open { visibility: visible; transform: none; opacity: 1; }
/* ?panel=open share renders show the review, not the tooling */
#artifact-annotate-panel.sharemode .actions { display: none; }
#artifact-annotate-panel header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; border-bottom: 1px solid var(--aa-border); font-weight: 650;
}
#artifact-annotate-panel .list { flex: 1; overflow-y: auto; padding: 8px 14px; }
#artifact-annotate-panel .hint { color: var(--aa-muted); font-size: 12px; margin: 0 0 8px; }
#artifact-annotate-panel .item {
  border: 1px solid var(--aa-border); border-radius: 6px; padding: 8px; margin-bottom: 8px;
}
#artifact-annotate-panel .item .quote {
  font-style: italic; color: var(--aa-muted); font-size: 12px; margin-bottom: 4px;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
#artifact-annotate-panel .item .stale {
  display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
  background: color-mix(in srgb, var(--aa-accent) 20%, transparent);
  color: var(--aa-accent); border-radius: 4px; padding: 1px 5px; margin-bottom: 4px;
}
#artifact-annotate-panel .item .actions { margin-top: 4px; }
#artifact-annotate-panel .item textarea {
  width: 100%; box-sizing: border-box; min-height: 50px; resize: vertical;
  font: 13px/1.5 system-ui, sans-serif; margin-top: 4px; padding: 6px 8px;
  background: var(--aa-code-bg); color: var(--aa-fg);
  border: 1px solid var(--aa-border); border-radius: 8px; outline: none;
}
#artifact-annotate-panel .item textarea:focus { border-color: var(--aa-accent); }
#artifact-annotate-panel button.link {
  background: none; border: none; color: var(--aa-accent); cursor: pointer;
  font-size: 12px; padding: 0 6px 0 0;
}
#artifact-annotate-panel footer { padding: 12px 14px; border-top: 1px solid var(--aa-border); }
#artifact-annotate-panel .send {
  width: 100%; padding: 9px; border: none; border-radius: 6px; cursor: pointer;
  background: var(--aa-accent); color: var(--aa-bg); font: 600 14px system-ui, sans-serif;
}
#artifact-annotate-panel .send:disabled { opacity: .5; cursor: default; }
#artifact-annotate-popover {
  position: absolute; z-index: 2147483001; width: 340px; padding: 0;
  background: var(--aa-bg); color: var(--aa-fg);
  border: 1px solid var(--aa-border); border-radius: 12px;
  box-shadow: 0 10px 34px rgba(0,0,0,.32);
  font: 13px system-ui, sans-serif; display: none; overflow: hidden;
  animation: aa-pop .16s ease;
}
#artifact-annotate-popover .pop-quote {
  padding: 10px 14px; font-style: italic; font-size: 12px; line-height: 1.4;
  color: var(--aa-muted);
  border-left: 3px solid var(--aa-accent);
  background: color-mix(in srgb, var(--aa-accent) 7%, transparent);
  max-height: 64px; overflow: hidden;
}
#artifact-annotate-popover .tabs { display: flex; gap: 4px; padding: 8px 10px 0; }
#artifact-annotate-popover .tabs button {
  all: unset; font: 600 11px system-ui, sans-serif; color: var(--aa-muted);
  padding: 4px 10px; border-radius: 999px; cursor: pointer;
}
#artifact-annotate-popover .tabs button.on {
  background: color-mix(in srgb, var(--aa-accent) 18%, transparent);
  color: var(--aa-accent);
}
#artifact-annotate-popover .pop-body { padding: 8px 10px; }
#artifact-annotate-popover textarea {
  width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical;
  font: 13px/1.5 system-ui, sans-serif; padding: 8px 10px; outline: none;
  background: var(--aa-code-bg); color: var(--aa-fg);
  border: 1px solid var(--aa-border); border-radius: 8px;
}
#artifact-annotate-popover textarea:focus {
  border-color: var(--aa-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aa-accent) 22%, transparent);
}
#artifact-annotate-popover .preview {
  min-height: 72px; max-height: 240px; overflow: auto; padding: 8px 10px;
  border: 1px dashed var(--aa-border); border-radius: 8px;
}
#artifact-annotate-popover .row {
  display: flex; align-items: center; gap: 6px; padding: 0 10px 10px;
}
#artifact-annotate-popover .kbd { flex: 1; color: var(--aa-muted); font-size: 11px; }
#artifact-annotate-popover .ghost, #artifact-annotate-popover .primary {
  all: unset; font: 600 12px system-ui, sans-serif; padding: 6px 12px; border-radius: 8px;
  cursor: pointer; transition: transform .12s ease, box-shadow .12s ease, background .12s ease;
}
#artifact-annotate-popover .ghost { color: var(--aa-muted); }
#artifact-annotate-popover .ghost:hover {
  color: var(--aa-fg);
  background: color-mix(in srgb, var(--aa-fg) 7%, transparent);
}
#artifact-annotate-popover .primary { background: var(--aa-accent); color: var(--aa-bg); }
#artifact-annotate-popover .primary:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(0,0,0,.25); }
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
  var urlParams = new URLSearchParams(location.search);
  window.__ARTIFACT_ANNOTATIONS__ = ${safeJson};

  var state = {
    mode: "off",
    annotations: (window.__ARTIFACT_ANNOTATIONS__ || []).slice(),
    editing: null,
    pending: null,
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

  var bgT = tok("--bg");
  if (!bgT) {
    bgT = getComputedStyle(document.body).backgroundColor;
    if (isTransparent(bgT)) bgT = htmlStyles.backgroundColor;
    if (isTransparent(bgT)) bgT = window.matchMedia("(prefers-color-scheme: dark)").matches ? "#171614" : "#ffffff";
  }
  var fgT = tok("--fg") || getComputedStyle(document.body).color || "#111111";
  if (Math.abs(lum(bgT) - lum(fgT)) < 0.25) fgT = lum(bgT) < 0.5 ? "#e6e6e6" : "#111111";

  var host = document.documentElement.style;
  host.setProperty("--aa-bg", bgT);
  host.setProperty("--aa-fg", fgT);
  host.setProperty("--aa-accent", tok("--accent") || "#d67858");
  if (tok("--muted")) host.setProperty("--aa-host-muted", tok("--muted"));
  if (tok("--border")) host.setProperty("--aa-host-border", tok("--border"));
  if (tok("--code-bg")) host.setProperty("--aa-host-code-bg", tok("--code-bg"));

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
  panel.innerHTML =
    '<header><span>Annotations</span><button class="link" data-close>close</button></header>' +
    '<div class="list"></div>' +
    '<footer><button class="send">Send to the agent</button></footer>';
  root.appendChild(panel);

  var popover = document.createElement("div");
  popover.id = "artifact-annotate-popover";
  popover.innerHTML =
    '<div class="pop-quote"></div>' +
    '<div class="tabs"><button type="button" data-tab="write" class="on">Write</button>' +
    '<button type="button" data-tab="preview">Preview</button></div>' +
    '<div class="pop-body"><textarea placeholder="What should the agent know about this? **markdown** works."></textarea>' +
    '<div class="preview md-preview" style="display:none"></div></div>' +
    '<div class="row"><span class="kbd">⌘⏎ to add · esc to cancel</span>' +
    '<button type="button" class="ghost" data-cancel>Cancel</button>' +
    '<button type="button" class="primary" data-add>Add</button></div>';
  root.appendChild(popover);

  var toast = document.createElement("div");
  toast.id = "artifact-annotate-toast";
  root.appendChild(toast);

  var listEl = panel.querySelector(".list");
  var sendBtn = panel.querySelector(".send");
  var popTextarea = popover.querySelector("textarea");
  var popPreview = popover.querySelector(".preview");
  var popQuote = popover.querySelector(".pop-quote");

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
    if (m === "off") hidePopover();
    render();
  }

  // ── persistence ───────────────────────────────────────────────────────────
  function put() {
    return fetch("/api/annotations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: SLUG,
        // Strip client-internal fields (_stale) — the sidecar holds the clean schema.
        annotations: state.annotations.map(function (a) {
          return { id: a.id, quote: a.quote, comment: a.comment, createdAt: a.createdAt };
        }),
      }),
    }).then(function (r) {
      if (!r.ok) throw new Error("save failed (" + r.status + ")");
    });
  }

  function persist() {
    put().catch(function () { showToast("Could not reach the server — comment kept in this tab only."); });
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
    var re = new RegExp(target.split(" ").map(function (w) { return w.replace(/[^\\w]/g, "\\\\$&"); }).join("\\\\s+"));
    var m = re.exec(flow.text);
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
      var r = findRange(a.quote);
      a._stale = !r;
      if (r && hl) hl.add(r);
    });
    if (hl) CSS.highlights.set("artifact-comment", hl);
  }

  // ── popover ─────────────────────────────────────────────────────────────
  function hidePopover() { popover.style.display = "none"; state.pending = null; setTab("write"); }

  var previewTimer = null;
  function setTab(which) {
    var tabs = popover.querySelectorAll("[data-tab]");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("on", tabs[i].getAttribute("data-tab") === which);
    var preview = which === "preview";
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
    var comment = norm(popTextarea.value);
    if (!comment || !state.pending) { hidePopover(); return; }
    var quote = { exact: state.pending.exact };
    if (state.pending.prefix) quote.prefix = state.pending.prefix;
    if (state.pending.suffix) quote.suffix = state.pending.suffix;
    state.annotations.push({ id: newId(), quote: quote, comment: comment, createdAt: new Date().toISOString() });
    state.editing = null;
    hidePopover();
    reHighlightAll(); render(); persist();
  }

  function onSelect() {
    if (STATIC || state.mode !== "annotate") return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var exact = sel.toString();
    if (!norm(exact)) return;
    var range = sel.getRangeAt(0);
    var ctx = contextAround(range);
    state.pending = { exact: exact, prefix: ctx.prefix, suffix: ctx.suffix };
    var q = norm(exact);
    if (q.length > 140) q = q.slice(0, 137) + "…";
    popQuote.textContent = '"' + q + '"';
    var rect = range.getBoundingClientRect();
    popover.style.display = "block";
    var top = window.scrollY + rect.bottom + 6;
    var left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 280);
    popover.style.top = top + "px";
    popover.style.left = Math.max(8, left) + "px";
    popTextarea.value = "";
    popTextarea.focus();
  }

  // ── render ────────────────────────────────────────────────────────────────
  function render() {
    var count = state.annotations.length;
    btn.innerHTML = STATIC
      ? count + (count === 1 ? " comment" : " comments")
      : (state.mode === "annotate" ? "Annotating" : "Annotate") + badge(count);
    if (!STATIC && !panelPinned) panel.classList.toggle("open", state.mode === "annotate");

    var hint = !STATIC && state.mode === "annotate"
      ? '<p class="hint">Select text in the page to add a comment. Esc to exit.</p>'
      : "";
    var items = state.annotations.map(function (a, i) {
      var stale = a._stale ? '<div class="stale">stale</div>' : "";
      var body = state.editing === i
        ? '<textarea data-edittext>' + escapeHtml(a.comment) + '</textarea>' +
          '<div class="actions"><button class="link" data-editsave="' + i + '">save</button>' +
          '<button class="link" data-editcancel>cancel</button></div>'
        : '<div class="comment md-preview">' + (a._html || escapeHtml(a.comment)) + '</div>' +
          (STATIC
            ? ''
            : '<div class="actions"><button class="link" data-edit="' + i + '">edit</button>' +
              '<button class="link" data-del="' + i + '">delete</button></div>');
      return '<div class="item" data-i="' + i + '">' + stale +
        '<div class="quote">"' + escapeHtml(a.quote.exact) + '"</div>' + body +
        '</div>';
    }).join("");
    var empty = count === 0 ? '<p class="hint">No comments yet.</p>' : "";
    listEl.innerHTML = hint + empty + items;
    sendBtn.disabled = count === 0;
    state.annotations.forEach(renderCommentHtml);
  }

  function badge(n) { return n > 0 ? ' <span class="badge">' + n + "</span>" : ""; }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── submit ─────────────────────────────────────────────────────────────
  function send() {
    sendBtn.disabled = true;
    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: SLUG }),
    }).then(function (r) {
      return r.json().then(function (body) { return { status: r.status, body: body }; });
    }).then(function (res) {
      if (res.status === 200 && res.body.delivered) {
        state.annotations = [];
        reHighlightAll();
        render();
        showToast("Sent to the agent ✨");
      } else if (res.status === 503 && res.body.feedback) {
        showFeedbackFallback(res.body.feedback);
        sendBtn.disabled = state.annotations.length === 0;
      } else {
        showToast(res.body && res.body.error ? res.body.error : "Send failed");
        sendBtn.disabled = state.annotations.length === 0;
      }
    }).catch(function () {
      showToast("Server unreachable — comments kept in this tab.");
      sendBtn.disabled = state.annotations.length === 0;
    });
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
    if (STATIC) { panel.classList.toggle("open"); return; }
    panelPinned = false;
    setMode(state.mode === "annotate" ? "off" : "annotate");
  });
  panel.addEventListener("click", function (e) {
    var t = e.target;
    if (t.hasAttribute("data-close")) { setMode("off"); return; }
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
      var comment = ta ? norm(ta.value) : "";
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
  document.addEventListener("mouseup", function () { setTimeout(onSelect, 0); });
  popover.addEventListener("click", function (e) {
    var t = e.target;
    if (t.hasAttribute("data-cancel")) { hidePopover(); return; }
    if (t.hasAttribute("data-add")) { addPending(); return; }
    var tab = t.getAttribute("data-tab");
    if (tab) setTab(tab);
  });
  popTextarea.addEventListener("input", function () {
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
      fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: SLUG, method: m }),
      }).then(function (r) { return r.json(); })
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
    if (STATIC) { panel.classList.remove("open"); return; }
    if (popover.style.display !== "none") { hidePopover(); return; }
    if (state.editing != null) { state.editing = null; render(); return; }
    if (state.mode === "annotate") setMode("off");
  });

  // ── boot ────────────────────────────────────────────────────────────────
  if (STATIC) panel.querySelector("footer").style.display = "none";
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
      bq.textContent = '"' + a.quote.exact + '"';
      var p = document.createElement("p");
      p.textContent = a.comment;
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
