import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { artifactKind, documentTitle, listArtifacts, run, writeArtifact } from './utils.js';

const cwd = process.cwd();
let temp: string;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'artifact-utils-'));
  process.chdir(temp);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(temp, { recursive: true, force: true });
});

const sleeper = [process.execPath, ['-e', 'setTimeout(() => {}, 30000)']] as const;

it('run() kills the child and rejects on timeout', async () => {
  const started = Date.now();
  await expect(run(sleeper[0], [...sleeper[1]], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  expect(Date.now() - started).toBeLessThan(5000);
});

it('run() kills the child and rejects when the signal aborts', async () => {
  const controller = new AbortController();
  const pending = run(sleeper[0], [...sleeper[1]], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await expect(pending).rejects.toThrow(/cancelled/);
  const aborted = new AbortController();
  aborted.abort();
  await expect(run(sleeper[0], [...sleeper[1]], { signal: aborted.signal })).rejects.toThrow(/cancelled/);
});

it('run() still resolves stdout and passes stdin', async () => {
  const out = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    input: 'hello',
    timeoutMs: 10_000,
  });
  expect(out).toBe('hello');
});

it('documentTitle decodes the entities the renderer writes', () => {
  expect(documentTitle('<title>A &amp; B &lt;x&gt;</title>')).toBe('A & B <x>');
  expect(documentTitle('<p>no title</p>')).toBe('');
});

it('artifactKind reads the meta or infers from the shell marker', () => {
  expect(artifactKind('<meta name="artifact-kind" content="html">')).toBe('html');
  expect(artifactKind('<style data-base>')).toBe('markdown');
  expect(artifactKind('<!DOCTYPE html><html></html>')).toBe('html');
});

it('listArtifacts returns decoded titles', () => {
  writeArtifact('a-b', '<html><head><title>A &amp; B</title><meta name="artifact-kind" content="html"></head></html>');
  expect(listArtifacts()).toMatchObject([{ slug: 'a-b', title: 'A & B', kind: 'html' }]);
});
