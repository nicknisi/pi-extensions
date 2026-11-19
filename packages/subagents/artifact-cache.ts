/**
 * Cached run-artifact reads for the polling views (footer statusline every
 * 2s, fleet overlay every 1s). Re-parsing up to 500 artifacts — each with up
 * to 64KB of output — on every tick blocks the event loop, so the parsed list
 * is reused until the artifacts tree changes. The runtime persists records by
 * writing a temp file and renaming it into `<root>/<namespace>/`, which bumps
 * that directory's mtime; a signature of the root's and each namespace dir's
 * mtimes therefore detects new and updated records with a few stats. A max
 * age bounds staleness from in-place rewrites (the startup ghost-run sweep).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRunArtifacts, type RunArtifact } from '@nicknisi/pi-shared';

function treeSignature(root: string): string {
  try {
    const parts = [String(fs.statSync(root).mtimeMs)];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        parts.push(`${entry.name}:${fs.statSync(path.join(root, entry.name)).mtimeMs}`);
      } catch {
        parts.push(`${entry.name}:?`);
      }
    }
    return parts.join('|');
  } catch {
    return 'missing';
  }
}

export interface ArtifactReaderOptions {
  read?: (root: string) => RunArtifact[];
  maxAgeMs?: number;
  now?: () => number;
}

export function createCachedArtifactReader({
  read = readRunArtifacts,
  maxAgeMs = 30_000,
  now = Date.now,
}: ArtifactReaderOptions = {}): (root: string) => RunArtifact[] {
  let cache: { root: string; signature: string; at: number; runs: RunArtifact[] } | undefined;
  return (root) => {
    const signature = treeSignature(root);
    const at = now();
    if (!cache || cache.root !== root || cache.signature !== signature || at - cache.at >= maxAgeMs) {
      cache = { root, signature, at, runs: read(root) };
    }
    return [...cache.runs];
  };
}
