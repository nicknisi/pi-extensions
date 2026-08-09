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
      files.push({ path: '', added: 0, removed: 0, created: false, deleted: false, header: [] });
      continue;
    }
    if (header) {
      if (line.startsWith('--- ')) {
        header.push(line);
        const src = line.slice(4).trim();
        if (src === '/dev/null') files[fileIndex]!.created = true;
        else files[fileIndex]!.sourcePath = src.replace(/^a\//, '');
        continue;
      }
      if (line.startsWith('+++ ')) {
        header.push(line);
        const dst = line.slice(4).trim().replace(/^b\//, '');
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
