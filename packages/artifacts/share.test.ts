import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const seen: { path: string; existed: boolean; content: string }[] = [];
vi.mock('./utils.js', async (original) => ({
  ...(await original<typeof import('./utils.js')>()),
  copyToClipboard: vi.fn(async () => {}),
  createGist: vi.fn(async (path: string) => {
    seen.push({ path, existed: existsSync(path), content: readFileSync(path, 'utf-8') });
    await new Promise((r) => setTimeout(r, 20)); // overlap concurrent shares
    return `https://gist.example/${seen.length}`;
  }),
}));

const { shareBaked, writeAnnotations } = await import('./feedback.js');
const { writeArtifact } = await import('./utils.js');

const cwd = process.cwd();
let temp: string;
const slug = 'share-test';

beforeEach(() => {
  seen.length = 0;
  temp = mkdtempSync(join(tmpdir(), 'artifact-share-'));
  process.chdir(temp);
  writeArtifact(slug, '<!DOCTYPE html><html><head><title>Share</title></head><body><p>Body text</p></body></html>');
  writeAnnotations(slug, [{ id: 'a1', comment: 'Note', createdAt: new Date().toISOString() }]);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(temp, { recursive: true, force: true });
});

it('gist shares bake comments into a private temp dir that is removed afterwards', async () => {
  const [a, b] = await Promise.all([shareBaked(slug, 'Share', 'gist'), shareBaked(slug, 'Share', 'gist')]);
  expect(a.count).toBe(1);
  expect(b.url).toBeDefined();
  expect(seen).toHaveLength(2);
  for (const s of seen) {
    expect(s.existed).toBe(true);
    expect(basename(s.path)).toBe(`${slug}-with-comments.html`);
    expect(dirname(dirname(s.path))).toBe(tmpdir());
    expect(basename(dirname(s.path))).toMatch(/^pi-artifacts-/);
    expect(s.content).toContain('static: true');
    expect(existsSync(dirname(s.path))).toBe(false);
  }
  // Concurrent shares of one slug never share (or delete) each other's file.
  expect(seen[0]!.path).not.toBe(seen[1]!.path);
});

it('gist shares without comments upload the artifact itself and create no temp dir', async () => {
  await shareBaked(slug, 'Share', 'gist', { bake: false });
  expect(seen).toHaveLength(1);
  expect(lstatSync(seen[0]!.path).isFile()).toBe(true);
  expect(seen[0]!.path).toBe(join(process.cwd(), '.pi', 'artifacts', `${slug}.html`));
});
