import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { READER_SCRIPT, READER_STYLES, readerBody } from './reader.js';
import { renderHtmlDocument, renderIndexPage, renderMarkdownDocument } from './templates.js';

const script = READER_SCRIPT.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');

function controlsHarness(storageThrows = false) {
  const values = new Map([
    ['unrelated-setting', 'keep'],
    ['pi-artifacts.reader.theme', 'dark'],
  ]);
  const button = () => {
    const attrs: Record<string, string> = {};
    const listeners: Record<string, () => void> = {};
    return {
      textContent: '',
      attrs,
      listeners,
      setAttribute(name: string, value: string) {
        attrs[name] = value;
      },
      addEventListener(name: string, fn: () => void) {
        listeners[name] = fn;
      },
    };
  };
  const theme = button(),
    size = button();
  const root = { dataset: { readerTheme: 'auto', readerSize: 'normal' } };
  const controls = { hidden: true, querySelector: (selector: string) => (selector.includes('theme') ? theme : size) };
  const prose = { querySelectorAll: () => [] };
  const document = {
    documentElement: root,
    querySelector: (selector: string) =>
      selector === '.reader-prose' ? prose : selector === '.reader-controls' ? controls : {},
  };
  const localStorage = {
    getItem(key: string) {
      if (storageThrows) throw new Error('blocked');
      return values.get(key);
    },
    setItem(key: string, value: string) {
      if (storageThrows) throw new Error('blocked');
      values.set(key, value);
    },
  };
  const window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
  new Script(script).runInNewContext({ document, localStorage, window });
  return { root, controls, theme, size, values };
}

describe('Markdown reader', () => {
  it('uses the reader only for Markdown and preserves code/diff renderers', () => {
    const html = renderMarkdownDocument(
      'Proposal',
      'proposal',
      '# A proposal\n\n## Details\n\n```ts\nconst name = "<value>";\n```\n\n```diff\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n```',
    );
    expect(html).toContain('data-artifact-reader data-reader-theme=');
    expect(html).toContain('class="reader-prose"');
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('d2h-file-wrapper');
    expect(html).not.toContain('<h1>Proposal</h1>');
    expect(renderHtmlDocument('Plain HTML', 'plain', '<p>Custom fragment</p>')).not.toContain('data-artifact-reader');
    expect(
      renderHtmlDocument('Full HTML', 'full', '<!DOCTYPE html><html><body>Custom page</body></html>'),
    ).not.toContain('data-artifact-reader');
    expect(renderIndexPage([])).not.toContain('data-artifact-reader');
  });
  it('escapes shell metadata and provides a title when Markdown has no h1', () => {
    const html = readerBody(
      '<script>bad</script>',
      '<p>Body stays intact</p>',
      '2026-09-09T12:00:00Z',
      '/tmp/<project>',
    );
    expect(html).toContain('<h1>&lt;script&gt;bad&lt;/script&gt;</h1>');
    expect(html).toContain('<p>Body stays intact</p>');
    expect(html).toContain('/tmp/&lt;project&gt;');
    expect(html).not.toContain('<script>bad');
  });
  it('embeds the font and its redistribution license without an external font request', () => {
    expect(READER_STYLES).toContain('data:font/woff2;base64,d09GMg');
    expect(READER_STYLES).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(READER_STYLES).not.toContain('fonts.googleapis.com');
    expect(READER_STYLES).toContain('[data-artifact-reader] #artifact-ui');
  });
  it('resets the legacy article sizing so wide tables cannot widen the mobile paper', () => {
    const paper = READER_STYLES.match(/\.reader-paper \{([^}]+)\}/)?.[1];
    expect(paper).toContain('width: 100%');
    expect(paper).toContain('margin: 0');
    expect(paper).toContain('min-width: 0');
    expect(READER_STYLES.match(/\.artifact-footer \{([^}]+)\}/)?.[1]).toContain('overflow-wrap: anywhere');
  });
  it('restores and toggles theme/size without navigating or touching other stored settings', () => {
    const { root, controls, theme, size, values } = controlsHarness();
    expect(root.dataset.readerTheme).toBe('dark');
    expect(controls.hidden).toBe(false);
    expect(theme.textContent).toBe('Light');
    theme.listeners.click!();
    expect(root.dataset.readerTheme).toBe('light');
    expect(values.get('pi-artifacts.reader.theme')).toBe('light');
    size.listeners.click!();
    expect(root.dataset.readerSize).toBe('large');
    expect(size.attrs['aria-pressed']).toBe('true');
    size.listeners.click!();
    expect(root.dataset.readerSize).toBe('normal');
    expect(values.get('unrelated-setting')).toBe('keep');
  });
  it('keeps the controls working when browser storage is blocked', () => {
    const { root, controls, theme, size } = controlsHarness(true);
    expect(controls.hidden).toBe(false);
    theme.listeners.click!();
    size.listeners.click!();
    expect(root.dataset.readerTheme).toBe('dark');
    expect(root.dataset.readerSize).toBe('large');
  });
});
