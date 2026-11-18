import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

const BANNED = ['isOther', 'isChat', 'isNext', 'wasCustom', 'wasChat'] as const;

function walkProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'docs') continue;
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkProductionTs(abs));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    out.push(abs);
  }
  return out;
}

describe('banned legacy discriminator flags', () => {
  it('no production source references the pre-1.0.3 boolean flags', () => {
    const files = walkProductionTs(PACKAGE_DIR);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const flag of BANNED) {
        const re = new RegExp(`\\b${flag}\\b`);
        if (re.test(text)) offenders.push(`${relative(PACKAGE_DIR, file)}: ${flag}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
