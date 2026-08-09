/**
 * Patch-parsing tests — parseUnifiedDiff is the /patches staging area's core
 * pure function; parseAmpDispatch is the & prefix grammar. Both are pinned
 * here against regression.
 */

import { describe, expect, it } from 'vitest';
import { parseAmpDispatch, parseUnifiedDiff } from './index.js';

const SIMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old
+new
 unchanged
`;

const MULTI = `${SIMPLE}diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/src/c.ts b/src/c.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/c.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`;

describe('parseUnifiedDiff', () => {
  it('parses files, hunks, and diffstat', () => {
    const p = parseUnifiedDiff(SIMPLE);
    expect(p.files).toHaveLength(1);
    expect(p.files[0]).toMatchObject({ path: 'src/a.ts', added: 1, removed: 1, created: false, deleted: false });
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]).toMatchObject({ fileIndex: 0, header: '@@ -1,2 +1,2 @@' });
    expect(p.totalAdded).toBe(1);
    expect(p.totalRemoved).toBe(1);
    // header is populated for sub-patch reconstruction
    expect(p.files[0]!.header.some((l) => l.startsWith('diff --git'))).toBe(true);
  });

  it('handles new and deleted files (deletion keeps its source path)', () => {
    const p = parseUnifiedDiff(MULTI);
    expect(p.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(p.files[1]!.created).toBe(true);
    const del = p.files[2]!;
    expect(del.deleted).toBe(true);
    expect(del.path).toBe('src/c.ts'); // source path, NOT '' — staleness checks depend on it
    expect(del.removed).toBe(1);
  });

  it('keeps the header for a hunkless (binary/mode-only) file in the middle of a multi-file patch', () => {
    const text = `${SIMPLE}diff --git a/bin/logo.png b/bin/logo.png
index 5555555..6666666 100644
Binary files a/bin/logo.png and b/bin/logo.png differ
diff --git a/src/d.ts b/src/d.ts
index 7777777..8888888 100644
--- a/src/d.ts
+++ b/src/d.ts
@@ -1,1 +1,1 @@
-a
+b
`;
    const p = parseUnifiedDiff(text);
    expect(p.files).toHaveLength(3);
    const bin = p.files[1]!;
    expect(bin.header.some((l) => l.startsWith('diff --git a/bin/logo.png'))).toBe(true);
    expect(bin.header.some((l) => l.startsWith('Binary files'))).toBe(true);
    // the following file still parses normally
    expect(p.files[2]!.path).toBe('src/d.ts');
    expect(p.hunks.filter((h) => h.fileIndex === 2)).toHaveLength(1);
  });

  it('round-trips an empty patch', () => {
    const p = parseUnifiedDiff('');
    expect(p.files).toHaveLength(0);
    expect(p.hunks).toHaveLength(0);
  });
});

describe('parseAmpDispatch', () => {
  it('parses agent + prompt', () => {
    expect(parseAmpDispatch('&scout how does auth work')).toEqual({ agentType: 'scout', prompt: 'how does auth work' });
  });

  it('no agent token — whole rest is the prompt', () => {
    expect(parseAmpDispatch('& how does auth work')).toEqual({ prompt: 'how does auth work' });
    expect(parseAmpDispatch('&how does auth work')).toEqual({ agentType: 'how', prompt: 'does auth work' });
  });

  it('single token is a prompt, not an agent', () => {
    expect(parseAmpDispatch('&scout')).toEqual({ prompt: 'scout' });
  });

  it('empty prompt is not dispatchable', () => {
    expect(parseAmpDispatch('&')).toBeNull();
    expect(parseAmpDispatch('& ')).toBeNull();
    expect(parseAmpDispatch('&   ')).toBeNull();
  });

  it('non-& input is not a dispatch', () => {
    expect(parseAmpDispatch('! ls')).toBeNull();
    expect(parseAmpDispatch('a & b')).toBeNull();
  });
});
