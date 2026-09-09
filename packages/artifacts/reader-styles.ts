export const READER_CSS = `
[data-artifact-reader] {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--reader-font);
  font-size: 18px;
  line-height: 1.8;
  min-height: 100%;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
[data-artifact-reader] *, [data-artifact-reader] *::before, [data-artifact-reader] *::after { box-sizing: border-box; }
[data-artifact-reader] body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: inherit; }
[data-artifact-reader] ::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }
[data-artifact-reader] :focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 75%, var(--reader-second)); outline-offset: 3px; }

.reader-header {
  min-height: 76px;
  position: sticky; top: 0; z-index: 1000;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.reader-brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 6px 0;
  color: var(--fg);
  font-size: 24px;
  font-weight: 900;
  letter-spacing: -.02em;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}
.reader-brand:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.reader-mark { position: relative; width: 24px; height: 24px; display: inline-block; }
.reader-mark::before, .reader-mark::after { content: ""; position: absolute; width: 16px; height: 16px; border-radius: 5px; transform: rotate(-12deg); }
.reader-mark::before { left: 0; top: 1px; background: var(--accent); }
.reader-mark::after { right: 0; bottom: 1px; background: var(--reader-second); border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent); }
.reader-crumb { min-width: 0; overflow: hidden; color: var(--muted); font-size: 14px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.reader-controls { margin-left: auto; margin-right: 190px; display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 1; white-space: nowrap; }
.reader-controls button {
  min-height: 42px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--reader-paper);
  color: var(--fg);
  font: 800 13px/1 var(--reader-font);
  cursor: pointer;
}
.reader-controls button:hover { border-color: var(--accent); color: var(--accent); }
.reader-controls[hidden], .reader-outline[hidden] { display: none; }
.reader-layout.reader-no-outline { grid-template-columns: minmax(0, var(--reader-max-width)); width: min(100% - 48px, var(--reader-max-width)); }
.reader-outline a { display: block; padding: 9px 12px; border-radius: 10px; }
.reader-outline a[aria-current] { background: var(--code-bg); color: var(--fg); }
.reader-outline a[aria-current]::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-right: 8px; }

.reader-layout {
  width: min(100% - 48px, calc(var(--reader-max-width) + 198px));
  margin: 0 auto;
  display: grid;
  grid-template-columns: 170px minmax(0, var(--reader-max-width));
  gap: 28px;
  align-items: start;
  padding: 34px 0 72px;
}
.reader-outline { position: sticky; top: 100px; padding: 9px 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.reader-outline > p { margin: 0 0 11px; color: var(--fg); font-size: 11px; font-weight: 900; letter-spacing: .09em; text-transform: uppercase; }
.reader-outline ol { margin: 0; padding: 0; list-style: none; }
.reader-outline li { margin: 5px 0; }
.reader-outline li[data-depth="3"] { padding-left: 13px; font-size: 12px; }
.reader-outline a { color: inherit; text-decoration: none; }
.reader-outline a:hover { color: var(--accent); }

.reader-paper {
  width: 100%;
  margin: 0;
  min-width: 0;
  padding: clamp(28px, 5vw, 58px) clamp(20px, 5vw, 68px) 42px;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--reader-paper);
  box-shadow: 0 16px 40px color-mix(in srgb, var(--fg) 7%, transparent);
}
.reader-meta { display: flex; align-items: center; gap: 11px; margin-bottom: 28px; color: var(--muted); font-size: 12px; font-weight: 800; line-height: 1.2; }
.reader-kind { padding: 5px 9px; border-radius: 999px; background: color-mix(in srgb, var(--reader-second) 18%, transparent); color: var(--fg); letter-spacing: .04em; text-transform: uppercase; }
.reader-meta time { font-variant-numeric: tabular-nums; }
.reader-prose { max-width: 70ch; overflow-wrap: break-word; }
.reader-prose > :first-child { margin-top: 0; }
.reader-prose :is(h1,h2,h3,h4,h5,h6) { color: var(--fg); font-weight: 900; line-height: 1.16; letter-spacing: -.045em; scroll-margin-top: 100px; }
.reader-prose h1 { margin: 0 0 .55em; font-size: clamp(34px, 5vw, 56px); }
.reader-prose h2 { margin: 2.15em 0 .65em; padding: 0; border: 0; font-size: clamp(23px, 2.2vw, 28px); }
.reader-prose h3 { margin: 2em 0 .6em; font-size: 23px; }
.reader-prose h4 { margin: 1.8em 0 .5em; font-size: 19px; letter-spacing: -.025em; }
.reader-prose h5, .reader-prose h6 { margin: 1.7em 0 .45em; font-size: 16px; letter-spacing: -.01em; }
.reader-prose p { margin: 0 0 1.35em; }
.reader-prose a { color: var(--accent); font-weight: 800; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent); text-decoration-thickness: .08em; text-underline-offset: .14em; }
.reader-prose a:hover { text-decoration-color: var(--accent); }
.reader-prose strong { font-weight: 900; }
.reader-prose em { color: color-mix(in srgb, var(--fg) 86%, var(--reader-second)); }
.reader-prose :is(ul,ol) { margin: 0 0 1.4em; padding-left: 1.4em; }
.reader-prose li { padding-left: .25em; margin: .35em 0; }
.reader-prose li::marker { color: var(--accent); font-weight: 900; }
.reader-prose li > :is(ul,ol) { margin: .35em 0 .15em; }
.reader-prose hr { height: 1px; margin: 3em 0; border: 0; background: var(--border); }
.reader-prose blockquote { margin: 1.8em 0; padding: 1.1em 1.25em; border: 1px solid color-mix(in srgb, var(--reader-second) 35%, var(--border)); border-radius: 14px; background: color-mix(in srgb, var(--reader-second) 10%, var(--code-bg)); color: color-mix(in srgb, var(--fg) 84%, var(--muted)); }
.reader-prose blockquote > :first-child { margin-top: 0; }
.reader-prose blockquote > :last-child { margin-bottom: 0; }
.reader-prose :is(img,svg,video) { display: block; max-width: 100%; height: auto; margin: 1.7em auto; border-radius: 10px; }
.reader-prose details { margin: 1.5em 0; padding: .8em 1em; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--code-bg) 65%, transparent); }
.reader-prose summary { cursor: pointer; color: var(--fg); font-weight: 900; }
.reader-prose details > :last-child { margin-bottom: 0; }
.reader-prose :is(code,kbd,samp,pre) { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
.reader-prose :not(pre) > code { padding: .16em .4em; border: 1px solid color-mix(in srgb, var(--border) 80%, transparent); border-radius: 6px; background: var(--code-bg); font-size: .82em; }
.reader-code { margin: 1.7em 0; overflow: hidden; border: 1px solid var(--border); border-radius: 13px; background: var(--code-bg); }
.reader-code-header { display: flex; align-items: center; justify-content: space-between; min-height: 38px; padding: 0 9px 0 14px; border-bottom: 1px solid var(--border); color: var(--muted); font: 800 11px/1 var(--reader-font); letter-spacing: .07em; text-transform: uppercase; }
.reader-code-header button { padding: 6px 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--reader-paper); color: var(--fg); font: 800 11px/1 var(--reader-font); cursor: pointer; text-transform: none; letter-spacing: 0; }
.reader-code-header button:hover { border-color: var(--accent); color: var(--accent); }
.reader-code-header span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reader-code-header button { flex: none; }
.reader-prose pre:not(.d2h-diff-table pre) { max-width: 100%; margin: 0; border: 0; border-radius: 0; padding: 17px 19px; overflow: auto; background: transparent; color: var(--fg); font-size: 13px; line-height: 1.65; tab-size: 2; }
.reader-prose pre:not(.d2h-diff-table pre) code { padding: 0; border: 0; background: transparent; font-size: inherit; }
.reader-table { max-width: 100%; margin: 1.7em 0; overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; }
.reader-prose table:not(.d2h-diff-table) { width: 100%; min-width: 520px; margin: 0; border-collapse: collapse; font-size: .84em; line-height: 1.55; }
.reader-prose table:not(.d2h-diff-table) :is(th,td) { padding: .75em .9em; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.reader-prose table:not(.d2h-diff-table) th { background: color-mix(in srgb, var(--code-bg) 76%, transparent); color: var(--muted); font-size: .82em; font-weight: 900; letter-spacing: .04em; }
.reader-prose table:not(.d2h-diff-table) tr:last-child td { border-bottom: 0; }
.reader-prose table:not(.d2h-diff-table) tr:hover td { background: color-mix(in srgb, var(--reader-second) 7%, transparent); }
.reader-prose .d2h-file-wrapper { max-width: none; }

.artifact-review { max-width: 70ch; margin-top: 3rem; padding-top: 1.75rem; border-top: 1px solid var(--border); color: var(--fg); font-family: var(--reader-font); }
.artifact-review :is(h2,h3) { color: var(--fg); font-weight: 900; letter-spacing: -.03em; }
.artifact-footer { overflow-wrap: anywhere; margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; line-height: 1.5; }

[data-artifact-reader] #artifact-ui { top: 16px; right: 24px; bottom: auto; font-family: var(--reader-font); }
[data-artifact-reader] #artifact-ui.review-open { right: 416px; left: auto; }
[data-artifact-reader] #artifact-ui :is(#artifact-annotate-btn,#artifact-share-btn) { font-family: var(--reader-font); min-height: 42px; border-radius: 12px; box-shadow: none; }
[data-artifact-reader] #artifact-annotate-btn { color: var(--reader-on-accent); }
[data-artifact-reader] #artifact-share-menu { top: 68px; right: 24px; bottom: auto; font-family: var(--reader-font); }
[data-artifact-reader] .aa-review-layout #artifact-share-menu { right: 416px; }
[data-artifact-reader] #artifact-share-menu button { font-family: var(--reader-font); }
[data-artifact-reader] #artifact-annotate-panel { font-family: var(--reader-font); }
[data-artifact-reader] #artifact-annotate-panel :is(button,textarea) { font-family: var(--reader-font); }
body.aa-review-layout .reader-controls { margin-right: 85px; }

[data-reader-size="large"] { font-size: 21px; }
[data-reader-size="large"] .reader-prose pre:not(.d2h-diff-table pre) { font-size: 14px; }
@media (max-width: 900px) {
  .reader-layout { grid-template-columns: 1fr; width: min(100% - 40px, var(--reader-max-width)); }
  .reader-outline { display: none; }
  [data-artifact-reader] #artifact-ui.review-open, [data-artifact-reader] .aa-review-layout #artifact-share-menu { right: 24px; left: auto; }
}
@media (max-width: 760px) {
  .reader-header { min-height: 76px; padding: 14px 20px; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 12px; }
  .reader-brand { grid-column: 1; grid-row: 1; }
  .reader-crumb { grid-column: 1; grid-row: 2; font-size: 12px; }
  .reader-controls, body.aa-review-layout .reader-controls { grid-column: 2; grid-row: 2; margin: 0; }
  .reader-controls button { min-height: 44px; padding: 0 9px; }
  .reader-layout { width: calc(100% - 28px); padding-top: 18px; }
  .reader-paper { padding: 28px 20px 32px; border-radius: 16px; }
}
@media (max-width: 500px) { .reader-controls button[data-reader-theme] { max-width: 72px; overflow: hidden; text-overflow: ellipsis; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
@media print {
  .reader-header, .reader-outline, .reader-code-header, #artifact-ui, #artifact-share-menu { display: none !important; }
  [data-artifact-reader], [data-artifact-reader] body { background: transparent; color: var(--fg); }
  .reader-layout, .reader-layout.reader-no-outline { display: block; width: auto; margin: 0; padding: 0; }
  .reader-paper { padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  .reader-prose { max-width: none; }
  .reader-code, .reader-table { break-inside: avoid; }
  .reader-prose a { color: inherit; }
  .reader-prose pre:not(.d2h-diff-table pre) { white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible; }
  .reader-table { overflow: visible; }
  .reader-prose table:not(.d2h-diff-table) { min-width: 0; }
}
`;
