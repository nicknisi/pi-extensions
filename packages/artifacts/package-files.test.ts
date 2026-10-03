import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

// Pi loads this package from its TypeScript source, so every module a shipped file
// imports must be listed in package.json "files" too. events.ts (#154) and
// requests.ts were both nearly published without it.
it('every module a shipped file imports is shipped too', () => {
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as { files: string[] };
  const files = new Set(pkg.files);
  const missing: string[] = [];
  for (const file of pkg.files.filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(here, file), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([^'"]+?)\.js['"]/g)) {
      const dependency = `${match[1]}.ts`;
      if (!files.has(dependency)) missing.push(`${file} imports ${dependency}`);
    }
  }
  expect(missing).toEqual([]);
});
