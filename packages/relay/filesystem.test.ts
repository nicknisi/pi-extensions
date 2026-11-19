import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openRelayRoot } from './filesystem.js';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('decodes native dirents of every name length and type', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dirent-')));
  fixtures.push(root);
  const files = ['a', 'b'.repeat(100), 'c'.repeat(255), 'd.json', 'ünïcødé'];
  for (const name of files) fs.writeFileSync(path.join(root, name), '');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'link'));

  const handle = openRelayRoot(root)!;
  try {
    const entries = handle.readDirectory();
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect([...byName.keys()].sort()).toEqual([...files, 'sub', 'link'].sort());
    for (const name of files) expect(byName.get(name)!.isFile()).toBe(true);
    expect(byName.get('sub')!.isDirectory()).toBe(true);
    expect(byName.get('link')!.isSymbolicLink()).toBe(true);
  } finally {
    handle.close();
  }
});
