/**
 * Smoke test for the example workflow files: each example file COMPILES under
 * the package's script compiler (`compileScript` — a stub dry-run, no real
 * spawn) and its `meta` export has a non-empty `name` + `description`.
 *
 * No real spawns: compileScript reads `meta` via a stub dry-run where
 * `agent`/`parallel`/`pipeline` are no-ops (see engine.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileScript } from './engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.join(here, 'examples');

const examples = fs
  .readdirSync(examplesDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(examplesDir, f));

describe('examples smoke: compile + meta', () => {
  it('discovers exactly the three example files', () => {
    expect(examples.map((e) => path.basename(e)).sort()).toEqual(['bake-off.js', 'gates.js', 'lanes.js']);
  });

  for (const file of examples) {
    const name = path.basename(file);
    it(`${name} compiles and exports meta.name + meta.description`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const compiled = compileScript(src);
      expect(typeof compiled.meta?.name).toBe('string');
      expect((compiled.meta?.name ?? '').length).toBeGreaterThan(0);
      expect(typeof compiled.meta?.description).toBe('string');
      expect((compiled.meta?.description ?? '').length).toBeGreaterThan(0);
    });
  }
});
