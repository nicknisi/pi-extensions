/** Pure helpers: slugify, artifact file I/O, browser open. */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { spawn } from 'node:child_process';

import { ARTIFACT_DIR } from './config.js';

/** Absolute path to the artifacts dir for the current project. */
export function artifactDir(): string {
  return join(process.cwd(), ARTIFACT_DIR);
}

/** Ensure the artifacts dir exists, return its absolute path. */
export function ensureArtifactDir(): string {
  const dir = artifactDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Kebab-case slug from a title. Lowercase, alnum + hyphens, trimmed. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/['"`]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'artifact'
  );
}

/** Reject path traversal; a slug must be a bare filename (no separators, no dots-prefix). */
export function isSafeSlug(slug: string): boolean {
  if (!slug) return false;
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) return false;
  if (!/^[a-z0-9-]+$/i.test(slug)) return false;
  return true;
}

/** Absolute path to a single artifact file. */
export function artifactPath(slug: string): string {
  return join(artifactDir(), `${slug}.html`);
}

/** Write artifact HTML to <slug>.html, creating the dir lazily. */
export function writeArtifact(slug: string, html: string): string {
  ensureArtifactDir();
  const path = artifactPath(slug);
  writeFileSync(path, html, 'utf-8');
  return path;
}

/** Read an artifact file, or null if missing. */
export function readArtifact(slug: string): string | null {
  const path = artifactPath(slug);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

/** Does the artifact file exist? */
export function artifactExists(slug: string): boolean {
  return existsSync(artifactPath(slug));
}

export interface ArtifactEntry {
  slug: string;
  title: string;
  kind: 'markdown' | 'html';
  mtime: number;
  absPath: string;
}

/** List artifacts newest-first: slug + title (from <title>) + kind + mtime. */
export function listArtifacts(): ArtifactEntry[] {
  const dir = artifactDir();
  if (!existsSync(dir)) return [];
  const entries: ArtifactEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.html')) continue;
    const absPath = join(dir, file);
    const content = readFileSync(absPath, 'utf-8');
    const slug = file.replace(/\.html$/, '');
    const titleMatch = content.match(/<title>(.*?)<\/title>/s);
    const kindMatch = content.match(/<meta name="artifact-kind" content="(.*?)"/);
    const kindRaw = kindMatch?.[1];
    // Meta present → trust it. Absent (pre-fix full-doc html or external file) →
    // infer from the shell marker: buildShell always emits <style data-base>, so
    // its presence means a rendered markdown/fragment artifact; absence means a
    // full-doc html or a foreign file → call it html.
    const kind: 'markdown' | 'html' =
      kindRaw === 'html' || kindRaw === 'markdown'
        ? kindRaw
        : content.includes('<style data-base')
          ? 'markdown'
          : 'html';
    entries.push({
      slug,
      title: titleMatch ? titleMatch[1]!.trim() : slug,
      kind,
      mtime: extractMtime(content) ?? statSync(absPath).mtimeMs,
      absPath,
    });
  }
  return entries.sort((a, b) => b.mtime - a.mtime);
}

/** Parse the generated-at timestamp embedded by the shell template. */
function extractMtime(html: string): number | null {
  const m = html.match(/<meta name="artifact-generated" content="(\d+)"/);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Normalize a request path and confirm it resolves inside the artifacts dir. Returns null if unsafe. */
export function safeArtifactPath(reqPath: string): string | null {
  const dir = artifactDir();
  const target = normalize(join(dir, reqPath));
  if (!target.startsWith(dir + sep) && target !== dir) return null;
  return target;
}

/**
 * Open a URL in the default browser.
 * On darwin: `open`; on win32: `rundll32 url.dll,FileProtocolHandler` (avoids `start` which
 * is a cmd.exe built-in and cannot be spawned directly); on linux: `xdg-open`.
 */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' })
    .on('error', (err) => console.warn(`openInBrowser: ${cmd} failed: ${err.message}`))
    .unref();
}

/** Run a command, resolve with trimmed stdout. Rejects with stderr (or spawn error) on failure. */
function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`${cmd} is not available: ${e.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited with code ${code}`)),
    );
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Copy text to the system clipboard (pbcopy / clip / wl-copy). */
export async function copyToClipboard(text: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? (['pbcopy', []] as const)
      : process.platform === 'win32'
        ? (['clip', []] as const)
        : (['wl-copy', []] as const);
  await run(cmd, [...args], text);
}

/** Reveal a file in the OS file manager (Finder / Explorer / xdg-open on its directory). */
export function revealFile(absPath: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', absPath]]
      : process.platform === 'win32'
        ? ['explorer', [`/select,${absPath}`]]
        : ['xdg-open', [dirname(absPath)]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' })
    .on('error', (err) => console.warn(`revealFile: ${cmd} failed: ${err.message}`))
    .unref();
}

/** Upload an artifact file as a GitHub gist via the gh CLI. Returns the gist URL. */
export async function createGist(absPath: string, title: string, isPublic: boolean): Promise<string> {
  const args = ['gist', 'create', absPath, '--desc', title];
  if (isPublic) args.push('--public');
  return run('gh', args);
}

/** Locate a headless-capable browser binary. darwin: known app paths; elsewhere: PATH names. */
function findBrowser(): string | null {
  if (process.platform === 'darwin') {
    for (const p of [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]) {
      if (existsSync(p)) return p;
    }
    return null;
  }
  // linux/win: rely on PATH; spawn errors surface as a clear message from run()
  return 'google-chrome';
}

/**
 * Screenshot a URL to a PNG via headless Chrome-family flags.
 * The artifact server must already be running (the caller ensures it).
 */
export async function screenshotUrl(url: string, outPath: string, width: number, height: number): Promise<void> {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      'no Chrome-family browser found (looked in /Applications). Install Chrome or Chromium to render images.',
    );
  }
  await run(browser, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--screenshot=${outPath}`,
    url,
  ]);
  if (!existsSync(outPath)) throw new Error('the browser exited without writing a screenshot.');
}

/** Copy a PNG file to the clipboard as an image (macOS only). Returns false on other platforms or failure. */
export async function copyImageToClipboard(absPath: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await run('osascript', ['-e', `set the clipboard to (read (POSIX file "${absPath}") as «class PNGf»)`]);
    return true;
  } catch {
    return false;
  }
}
