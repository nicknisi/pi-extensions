import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { renderReviewContent, renderRevisionComparison, savePreviousRevision } from './review.js';
import { listArtifacts } from './utils.js';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function inTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-review-'));
  tempDirs.push(dir);
  process.chdir(dir);
  mkdirSync('.pi/artifacts', { recursive: true });
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('renderReviewContent', () => {
  it('splices escaped native decisions and evidence before the artifact footer', () => {
    const output = renderReviewContent(
      '<body><p><a href="#artifact-evidence-proof">Proof</a></p><footer class="artifact-footer">footer</footer></body>',
      [
        {
          id: 'pick',
          question: 'Use <safe>?',
          options: [
            { value: 'yes', label: 'Yes & go' },
            { value: 'no', label: 'No' },
          ],
        },
      ],
      [
        {
          id: 'proof',
          title: 'Source <one>',
          source: 'Research & notes',
          quote: '<not html>',
          url: 'https://example.test/a?x=1&y=2',
        },
      ],
    );
    expect(output.indexOf('data-artifact-review')).toBeLessThan(output.indexOf('artifact-footer'));
    expect(output).toContain('<fieldset data-artifact-decision="pick"><legend>Use &lt;safe&gt;?</legend>');
    expect(output).toContain('<input type="radio" name="artifact-decision-pick" value="yes">Yes &amp; go');
    expect(output).toContain(
      '<details id="artifact-evidence-proof" data-artifact-evidence="proof"><summary>Source &lt;one&gt;</summary>',
    );
    expect(output).toContain('<blockquote><pre>&lt;not html&gt;</pre></blockquote>');
    expect(output).not.toMatch(/<input\b[^>]*\schecked(?:\s|=|>)/);
  });

  it('rejects unsafe review data and URL schemes', () => {
    expect(() =>
      renderReviewContent(
        '',
        [
          {
            id: '../bad',
            question: 'Q',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          },
        ],
        [],
      ),
    ).toThrow();
    expect(() =>
      renderReviewContent('', [{ id: 'ok', question: 'Q', options: [{ value: 'a', label: 'A' }] }], []),
    ).toThrow();
    expect(() => renderReviewContent('', [], [{ id: 'e', title: 'E', url: 'javascript:alert(1)' }])).toThrow();
  });
});

describe('revisions', () => {
  it('rotates one JSON snapshot without creating indexable artifacts and compares changed source', () => {
    const dir = inTempProject();
    const artifacts = join(dir, '.pi/artifacts');
    writeFileSync(join(artifacts, 'demo.html'), '<p>old html</p>');
    writeFileSync(join(artifacts, 'demo.md'), 'same\nold line\ntail');
    savePreviousRevision('demo');
    writeFileSync(join(artifacts, 'demo.html'), '<p>new html</p>');
    writeFileSync(join(artifacts, 'demo.md'), 'same\nnew line\ntail');
    const comparison = renderRevisionComparison('demo');
    expect(comparison).toContain('<h1>Changes</h1>');
    expect(comparison).toContain('Static, noninteractive preview');
    expect(comparison).toContain('title="Previous artifact preview" sandbox=""');
    expect(comparison).toContain('title="Current artifact preview" sandbox=""');
    expect(comparison).toContain('<details class="source-changes"><summary>Source changes</summary>');
    expect(comparison).toContain('Markdown source. Highlighted lines are the changed region.');
    expect(comparison).toContain('<mark>old line</mark>');
    expect(comparison).toContain('<mark>new line</mark>');
    expect(comparison).toContain('href="/demo.html"');
    expect(existsSync(join(artifacts, 'demo.previous.json'))).toBe(true);
    expect(readFileSync(join(artifacts, 'demo.previous.json'), 'utf-8')).toContain('old html');
    expect(existsSync(join(artifacts, 'demo.previous.html'))).toBe(false);
    expect(listArtifacts().map((entry) => entry.slug)).toEqual(['demo']);
    savePreviousRevision('demo');
    expect(readFileSync(join(artifacts, 'demo.previous.json'), 'utf-8')).toContain('new html');
  });

  it('keeps snapshot text accessible while blocking scripts, network, and form interaction', () => {
    const dir = inTempProject();
    const artifacts = join(dir, '.pi/artifacts');
    writeFileSync(
      join(artifacts, 'unsafe.html'),
      '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/"><script>alert(1)</script></head><body class="custom-theme"><a href="https://evil.test">Readable link text</a><form action="https://evil.test"><input></form><iframe srcdoc="<script>alert(2)</script>"></iframe><p>current</p></body></html>',
    );
    savePreviousRevision('unsafe');
    writeFileSync(join(artifacts, 'unsafe.html'), '<p>updated</p>');

    const comparison = renderRevisionComparison('unsafe')!;
    const previews = [...comparison.matchAll(/srcdoc="([^"]*)"/g)].map((match) =>
      match[1]!
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    );
    const previousPreview = previews[0]!;
    expect(comparison).toContain('sandbox=""');
    expect(comparison).not.toContain('allow-scripts');
    expect(comparison).not.toContain('allow-same-origin');
    expect(previousPreview).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(previousPreview).not.toContain('<body inert>');
    expect(previousPreview).toContain('<body class="custom-theme">');
    expect(previousPreview).toContain('<a>Readable link text</a>');
    expect(previousPreview).toContain('<input disabled>');
    expect(previousPreview).toContain('form,button,input,select,textarea{pointer-events:none}');
    expect(previousPreview).not.toContain('alert(1)');
    expect(previousPreview).not.toContain('alert(2)');
    expect(previousPreview).not.toContain('http-equiv="refresh"');
    expect(previousPreview).not.toContain('base href=');
    expect(previousPreview).not.toContain('<iframe');
  });

  it('does not create a snapshot for a missing artifact and validates slugs', () => {
    const dir = inTempProject();
    savePreviousRevision('missing');
    expect(existsSync(join(dir, '.pi/artifacts/missing.previous.json'))).toBe(false);
    expect(() => savePreviousRevision('../outside')).toThrow('unsafe artifact slug');
    expect(() => renderRevisionComparison('../outside')).toThrow('unsafe artifact slug');
  });
});
