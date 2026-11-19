import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunArtifact } from '@nicknisi/pi-shared';
import { createCachedArtifactReader } from './artifact-cache.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-cache-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'subagents'));
  let reads = 0;
  const read = (): RunArtifact[] => {
    reads++;
    return [];
  };
  return { root, read, reads: () => reads };
}

/** Write like the runtime does: temp file, then rename into place (bumps the dir mtime). */
function persist(root: string, name: string) {
  const file = path.join(root, 'subagents', name);
  fs.writeFileSync(`${file}.tmp`, '{}');
  fs.renameSync(`${file}.tmp`, file);
  // Force a distinct mtime even on coarse-grained filesystems.
  const future = new Date(Date.now() + 5000 + Math.random() * 1000);
  fs.utimesSync(path.join(root, 'subagents'), future, future);
}

describe('createCachedArtifactReader', () => {
  it('reuses the parsed list until the artifacts tree changes', () => {
    const { root, read, reads } = setup();
    const reader = createCachedArtifactReader({ read });
    reader(root);
    reader(root);
    expect(reads()).toBe(1);
    persist(root, 'a.json');
    reader(root);
    expect(reads()).toBe(2);
    reader(root);
    expect(reads()).toBe(2);
  });

  it('re-reads once the cache is older than maxAgeMs', () => {
    const { root, read, reads } = setup();
    let now = 0;
    const reader = createCachedArtifactReader({ read, maxAgeMs: 1000, now: () => now });
    reader(root);
    now = 999;
    reader(root);
    expect(reads()).toBe(1);
    now = 1000;
    reader(root);
    expect(reads()).toBe(2);
  });

  it('returns a fresh array each call', () => {
    const { root } = setup();
    const reader = createCachedArtifactReader({ read: () => [] });
    expect(reader(root)).not.toBe(reader(root));
  });
});
