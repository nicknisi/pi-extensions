/**
 * Unified-diff parsing for the subagents /patches staging area.
 * Pure functions — no pi imports, so they are unit-testable.
 */

export interface PatchFileStat {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  /** True when the diff deletes the file (+++ /dev/null); path holds the source path. */
  deleted: boolean;
  /** Source path from the `--- a/…` line (kept for deletions). */
  sourcePath?: string;
  header: string[];
}

export interface PatchHunk {
  fileIndex: number;
  header: string;
  body: string[];
}

export interface ParsedPatch {
  files: PatchFileStat[];
  hunks: PatchHunk[];
  totalAdded: number;
  totalRemoved: number;
}

/** Strip git's C-style quoting from a header path (`"a/x\ty"`), when quoted. */
function unquoteGitPath(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\' || i === body.length - 1) {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[++i]!;
    const octal = /^[0-7]{3}/.exec(body.slice(i, i + 3));
    if (octal) {
      // Non-ASCII bytes are octal-escaped (core.quotePath).
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Source/destination paths from a `diff --git a/X b/Y` line. Binary hunks,
 * pure renames and mode-only changes have no ---/+++ lines, so this is their
 * only path source. Paths with spaces are ambiguous in this line; the
 * symmetric (X === Y) case is resolved exactly, otherwise the last ` b/` wins.
 */
function gitHeaderPaths(line: string): { src: string; dst: string } | null {
  const rest = line.slice('diff --git '.length);
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$|^("(?:[^"\\]|\\.)*") (.+)$/.exec(rest);
  if (quoted && (rest.startsWith('"') || rest.endsWith('"'))) {
    const a = unquoteGitPath(quoted[1] ?? quoted[3]!);
    const b = unquoteGitPath(quoted[2] ?? quoted[4]!);
    return { src: a.replace(/^a\//, ''), dst: b.replace(/^b\//, '') };
  }
  if (!rest.startsWith('a/')) return null;
  // Symmetric: "a/X b/X" has length 2*len(X) + 5.
  if ((rest.length - 5) % 2 === 0) {
    const n = (rest.length - 5) / 2;
    const x = rest.slice(2, 2 + n);
    if (rest === `a/${x} b/${x}`) return { src: x, dst: x };
  }
  const split = rest.lastIndexOf(' b/');
  if (split < 0) return null;
  return { src: rest.slice(2, split), dst: rest.slice(split + 3) };
}

export function parseUnifiedDiff(text: string): ParsedPatch {
  const lines = text.split('\n');
  const files: PatchFileStat[] = [];
  const hunks: PatchHunk[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let fileIndex = -1;
  let header: string[] | null = null;
  let hunk: PatchHunk | null = null;
  const flushHunk = () => {
    if (hunk) {
      hunks.push(hunk);
      hunk = null;
    }
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushHunk();
      // A hunkless file (binary / mode-only change) still owns its header —
      // flush it before starting the next file or sub-patch reconstruction
      // for that file would lose it.
      if (header && fileIndex >= 0) files[fileIndex]!.header = header;
      fileIndex = files.length;
      header = [line];
      // Seed paths from the git header; rename/---/+++ lines override them.
      const seeded = gitHeaderPaths(line);
      files.push({
        path: seeded?.dst ?? '',
        added: 0,
        removed: 0,
        created: false,
        deleted: false,
        ...(seeded ? { sourcePath: seeded.src } : {}),
        header: [],
      });
      continue;
    }
    if (header) {
      if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
        header.push(line);
        files[fileIndex]!.sourcePath = unquoteGitPath(line.slice(line.indexOf(' from ') + 6));
        continue;
      }
      if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
        header.push(line);
        files[fileIndex]!.path = unquoteGitPath(line.slice(line.indexOf(' to ') + 4));
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        // Hunkless deletions (binary) never reach a +++ /dev/null line.
        files[fileIndex]!.deleted = true;
        header.push(line);
        continue;
      }
      if (line.startsWith('new file mode ')) {
        files[fileIndex]!.created = true;
        header.push(line);
        continue;
      }
      if (line.startsWith('--- ')) {
        header.push(line);
        const src = unquoteGitPath(line.slice(4).trim());
        if (src === '/dev/null') files[fileIndex]!.created = true;
        else files[fileIndex]!.sourcePath = src.replace(/^a\//, '');
        continue;
      }
      if (line.startsWith('+++ ')) {
        header.push(line);
        const dst = unquoteGitPath(line.slice(4).trim()).replace(/^b\//, '');
        if (dst === '/dev/null') {
          // Deletion: the destination is /dev/null, so keep the source path —
          // otherwise staleness checks resolve '' to the cwd and never fire.
          files[fileIndex]!.deleted = true;
          files[fileIndex]!.path = files[fileIndex]!.sourcePath ?? '';
        } else {
          files[fileIndex]!.path = dst;
        }
        continue;
      }
      if (line.startsWith('@@')) {
        files[fileIndex]!.header = header;
        header = null;
        flushHunk();
        hunk = { fileIndex, header: line, body: [] };
        continue;
      }
      header.push(line);
      continue;
    }
    if (hunk) {
      if (line.startsWith('@@')) {
        flushHunk();
        hunk = { fileIndex, header: line, body: [] };
        continue;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        files[fileIndex]!.added++;
        totalAdded++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        files[fileIndex]!.removed++;
        totalRemoved++;
      }
      hunk.body.push(line);
    }
  }
  flushHunk();
  if (header && fileIndex >= 0) files[fileIndex]!.header = header;
  return { files, hunks, totalAdded, totalRemoved };
}
