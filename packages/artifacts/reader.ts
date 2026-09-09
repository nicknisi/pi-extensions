/** Markdown-only document chrome and progressive reader controls. */
import { readFileSync } from 'node:fs';
import { READER_CONFIG } from './config.js';
import { READER_CSS } from './reader-styles.js';
import { schemeTokens } from './styles.js';

function embeddedFont(): string {
  // Sources live beside assets, compiled modules one directory below them.
  for (const base of ['./assets/', '../assets/']) {
    try {
      const font = readFileSync(new URL(`${base}nunito-sans-latin.woff2`, import.meta.url));
      const license = readFileSync(new URL(`${base}OFL.txt`, import.meta.url), 'utf8');
      return `/* ${license} */\n@font-face{font-family:"Nunito Sans";font-style:normal;font-weight:400 900;font-display:swap;src:url(data:font/woff2;base64,${font.toString('base64')}) format("woff2")}`;
    } catch {
      // A missing optional font must not prevent an artifact from opening.
    }
  }
  return '';
}

const LIGHT = `${schemeTokens('light')}
  --bg:#eff0f6;--fg:#202334;--muted:#606579;--border:#d9dce7;--code-bg:#f6f6fb;
  --accent:${READER_CONFIG.accentLight};--reader-second:#6556b8;--reader-paper:#ffffff;--reader-on-accent:#ffffff;`;
const DARK = `${schemeTokens('dark')}
  --bg:#14151e;--fg:#f5f3fa;--muted:#b5b5c8;--border:#383b4d;--code-bg:#252735;
  --accent:${READER_CONFIG.accent};--reader-second:#b9adff;--reader-paper:#1c1e2a;--reader-on-accent:#281725;`;

export const READER_STYLES = `<style data-reader>
${embeddedFont()}
:root[data-artifact-reader]{${LIGHT}color-scheme:light;--reader-font:"Nunito Sans",ui-rounded,system-ui,sans-serif;--reader-max-width:${READER_CONFIG.maxWidth}px;}
@media(prefers-color-scheme:dark){:root[data-artifact-reader][data-reader-theme="auto"]{${DARK}color-scheme:dark;}}
:root[data-artifact-reader][data-reader-theme="dark"]{${DARK}color-scheme:dark;}
${READER_CSS}
</style>`;

export const READER_ATTRIBUTES = `data-artifact-reader data-reader-theme="${READER_CONFIG.theme}" data-reader-size="normal"`;

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function readerBody(title: string, bodyHtml: string, generatedIso: string, projectPath: string): string {
  const heading = /<h1\b/i.test(bodyHtml) ? '' : `<h1>${escape(title)}</h1>`;
  return `<header class="reader-header">
<a class="reader-brand" href="/"><span class="reader-mark" aria-hidden="true"></span>artifacts</a>
<span class="reader-crumb">${escape(title)}</span>
<div class="reader-controls" hidden><button type="button" data-reader-size aria-label="Use larger reading text" aria-pressed="false">Aa</button><button type="button" data-reader-theme>Theme</button></div>
</header>
<main class="reader-layout reader-no-outline">
<nav class="reader-outline" aria-label="On this page" hidden><p>On this page</p><ol></ol></nav>
<article class="reader-paper">
<div class="reader-meta"><span class="reader-kind">Markdown</span><time datetime="${escape(generatedIso)}">${escape(generatedIso.slice(0, 10))}</time></div>
<div class="reader-prose">${heading}${bodyHtml}</div>
<footer class="artifact-footer">source: ${escape(projectPath)}</footer>
</article></main>`;
}

export const READER_SCRIPT = `<script data-reader-controls>
(function () {
  var root = document.documentElement;
  var prose = document.querySelector('.reader-prose');
  var controls = document.querySelector('.reader-controls');
  if (!prose || !controls) return;
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var themeButton = controls.querySelector('[data-reader-theme]');
  var sizeButton = controls.querySelector('[data-reader-size]');
  function store(key, value) { try { localStorage.setItem('pi-artifacts.reader.' + key, value); } catch (_) {} }
  try {
    var theme = localStorage.getItem('pi-artifacts.reader.theme');
    var size = localStorage.getItem('pi-artifacts.reader.size');
    if (theme === 'light' || theme === 'dark') root.dataset.readerTheme = theme;
    if (size === 'normal' || size === 'large') root.dataset.readerSize = size;
  } catch (_) {}
  function dark() { return root.dataset.readerTheme === 'dark' || (root.dataset.readerTheme === 'auto' && media.matches); }
  function syncControls() {
    themeButton.textContent = dark() ? 'Light' : 'Dark';
    themeButton.setAttribute('aria-label', dark() ? 'Switch to light theme' : 'Switch to dark theme');
    var large = root.dataset.readerSize === 'large';
    sizeButton.setAttribute('aria-pressed', String(large));
    sizeButton.setAttribute('aria-label', large ? 'Use normal reading text' : 'Use larger reading text');
  }
  themeButton.addEventListener('click', function () {
    root.dataset.readerTheme = dark() ? 'light' : 'dark';
    store('theme', root.dataset.readerTheme); syncControls();
  });
  sizeButton.addEventListener('click', function () {
    root.dataset.readerSize = root.dataset.readerSize === 'large' ? 'normal' : 'large';
    store('size', root.dataset.readerSize); syncControls();
  });
  media.addEventListener('change', syncControls);
  syncControls(); controls.hidden = false;

  var nav = document.querySelector('.reader-outline');
  var headings = Array.from(prose.querySelectorAll('h2,h3')).filter(function (heading) { return !heading.closest('.artifact-mermaid, .d2h-wrapper'); });
  var links = new Map();
  headings.forEach(function (heading) {
    if (!heading.id) {
      var base = 'reader-' + (heading.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section');
      var id = base, n = 2;
      while (document.getElementById(id)) id = base + '-' + n++;
      heading.id = id;
    }
    var item = document.createElement('li'), link = document.createElement('a');
    item.dataset.depth = heading.tagName.slice(1);
    link.href = '#' + encodeURIComponent(heading.id);
    link.textContent = heading.textContent;
    item.appendChild(link); nav.querySelector('ol').appendChild(item); links.set(heading, link);
  });
  function current(heading) {
    links.forEach(function (link, target) {
      if (target === heading) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    });
  }
  if (headings.length) {
    nav.hidden = false; document.querySelector('.reader-layout').classList.remove('reader-no-outline');
    current(headings[0]);
    if (typeof IntersectionObserver !== 'undefined') {
      var visible = new Set();
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) { if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target); });
        var first = headings.find(function (heading) { return visible.has(heading); });
        if (first) current(first);
      }, { rootMargin: '-80px 0px -55% 0px' });
      headings.forEach(function (heading) { observer.observe(heading); });
    }
  }

  prose.querySelectorAll('pre > code').forEach(function (code) {
    var pre = code.parentElement;
    if (pre.closest('.artifact-mermaid, .d2h-wrapper, .reader-code')) return;
    var wrapper = document.createElement('div'), header = document.createElement('div');
    var label = document.createElement('span'), copy = document.createElement('button');
    var match = code.className.match(/(?:^|\\s)language-([^\\s]+)/);
    var language = match ? match[1] : 'Code';
    wrapper.className = 'reader-code'; header.className = 'reader-code-header'; label.textContent = language;
    copy.type = 'button'; copy.textContent = 'Copy'; copy.dataset.readerCopy = '';
    copy.setAttribute('aria-label', 'Copy ' + language + ' code'); copy.setAttribute('aria-live', 'polite');
    copy.addEventListener('click', async function () {
      copy.disabled = true;
      try { await navigator.clipboard.writeText(code.textContent); copy.textContent = 'Copied'; }
      catch (_) { copy.textContent = 'Select code to copy'; }
      copy.setAttribute('aria-label', copy.textContent);
      copy.disabled = false;
      setTimeout(function () { copy.textContent = 'Copy'; copy.setAttribute('aria-label', 'Copy ' + language + ' code'); }, 2400);
    });
    pre.before(wrapper); header.append(label, copy); wrapper.append(header, pre);
  });
  prose.querySelectorAll('table:not(.d2h-diff-table)').forEach(function (table) {
    if (table.closest('.d2h-wrapper, .reader-table')) return;
    var wrapper = document.createElement('div'); wrapper.className = 'reader-table';
    wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Scrollable table');
    table.before(wrapper); wrapper.appendChild(table);
  });
})();
</script>`;
