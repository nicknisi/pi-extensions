/**
 * Terminal-title tests — the unnamed-session fallback used to hardcode "Pi",
 * which was wrong twice over: pi itself titles windows "π", and a rebranded
 * distribution (arc, tau, …) should see its own name.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTitle } from './index.js';

const original = process.env.PI_PACKAGE_DIR;

/** A package dir whose manifest brands pi as `name`, the way arc does. */
function brandedPackageDir(name?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-name-brand-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(name ? { name: 'pi', piConfig: { name } } : { name: 'pi' }));
  return dir;
}

afterEach(() => {
  if (original === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = original;
});

describe('buildTitle', () => {
  it('uses the format when the session is named', () => {
    expect(buildTitle('Fix the parser', '/tmp/work', '{summary} — {dir}')).toBe('Fix the parser — work');
  });

  it('falls back to the app name and dir when the session is unnamed', () => {
    process.env.PI_PACKAGE_DIR = brandedPackageDir('arc');
    expect(buildTitle(undefined, '/tmp/work', '{summary} — {dir}')).toBe('arc — work');
  });

  it('falls back to π on an unbranded pi', () => {
    process.env.PI_PACKAGE_DIR = brandedPackageDir();
    expect(buildTitle(undefined, '/tmp/work', '{summary} — {dir}')).toBe('π — work');
  });

  it('substitutes {app} in the format', () => {
    process.env.PI_PACKAGE_DIR = brandedPackageDir('arc');
    expect(buildTitle('Fix the parser', '/tmp/work', '{app}: {summary} ({dir})')).toBe('arc: Fix the parser (work)');
  });
});
