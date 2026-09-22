import { expect, it } from 'vitest';
import { fixture } from './host.test.js';
it('escapes shell metadata and sandboxes direct HTML and SVG', async () => {
  const f = await fixture();
  const hostile = '<script>parent.document.body.innerHTML="owned"</script>';
  const { slug } = await (
    await f.upload(
      { 'index.html': hostile, 'nested/evil.svg': '<svg onload="alert(1)"/>' },
      undefined,
      undefined,
      '</title><script>alert(1)</script>',
    )
  ).json();
  await f.makePublic(slug);
  const shell = await fetch(`${f.url}/${slug}/`);
  const html = await shell.text();
  expect(shell.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(html).toContain('sandbox="allow-scripts"');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;/title&gt;');
  for (const path of ['index.html', 'nested/evil.svg']) {
    const content = await fetch(`${f.url}/${slug}/${path}`);
    expect(content.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts;');
    expect(content.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
    expect(content.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(content.headers.get('X-Content-Type-Options')).toBe('nosniff');
  }
});
