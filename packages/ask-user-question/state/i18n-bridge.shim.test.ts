/**
 * Regression tests for the i18n soft-peer dynamic-load shim.
 *
 * The shim has two halves:
 *   - bridge module (this directory) — `await import("@juicesharp/rpiv-i18n")`
 *     inside try/catch; on failure, `t` becomes an identity passthrough.
 *   - extension entry point (../index.ts) — `await import(...)` wraps the
 *     `registerStrings(...)` call; on failure, no-op.
 *
 * Both must use a DYNAMIC import. A static
 *     import { ... } from "@juicesharp/rpiv-i18n";
 * is hoisted to module-load and throws `Cannot find module` if the SDK isn't
 * installed (standalone install of just this package), taking the entire
 * extension offline. These tests guard against that regression by reading
 * the source files and asserting the import shape.
 *
 * We also exercise the JavaScript-spec guarantee that `await import(...)` on
 * a missing module rejects with a throwable error — the foundation of the
 * try/catch fallback. If a future Node release breaks that contract, the
 * runtime test below catches it before users do.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = resolve(PACKAGE_DIR, 'state/i18n-bridge.ts');
const ENTRY = resolve(PACKAGE_DIR, 'index.ts');
const SDK_SPECIFIER = '@juicesharp/rpiv-i18n';

// The specifier may carry an optional subpath (e.g. `/loader`) — the entry
// point uses `@juicesharp/rpiv-i18n/loader` to avoid pulling the UI module
// into the load graph; the bridge uses the bare `@juicesharp/rpiv-i18n`
// specifier for runtime lookup. Both forms must be dynamic-imported.
const SDK_SPECIFIER_PATTERN = String.raw`${SDK_SPECIFIER}(?:/[\w-]+)?`;
const STATIC_IMPORT = new RegExp(
  String.raw`^\s*import\s+(?:type\s+)?[\w{},\s*]+\s+from\s+["']${SDK_SPECIFIER_PATTERN}["']`,
  'm',
);
// Fork: the specifier lives in an `I18N_SDK` constant so this repo's typecheck doesn't follow the
// optional peer (it ships raw .ts). The constant must hold the SDK name and feed an awaited import().
const DYNAMIC_IMPORT = new RegExp(
  String.raw`const I18N_SDK: string = ["']${SDK_SPECIFIER}["'];[\s\S]*await\s+import\s*\(\s*(?:I18N_SDK|\`\$\{I18N_SDK\}/[\w-]+\`)\s*\)`,
);

describe('i18n soft-peer shim — source shape', () => {
  it('bridge does not statically import the rpiv-i18n SDK', () => {
    const src = readFileSync(BRIDGE, 'utf8');
    expect(src).not.toMatch(STATIC_IMPORT);
  });

  it('bridge uses await import() for the rpiv-i18n SDK', () => {
    const src = readFileSync(BRIDGE, 'utf8');
    expect(src).toMatch(DYNAMIC_IMPORT);
  });

  it('bridge guards the dynamic import with try/catch', () => {
    const src = readFileSync(BRIDGE, 'utf8');
    expect(src).toMatch(/\btry\s*\{[\s\S]*?\bcatch\b/);
  });

  it('entry point does not statically import the rpiv-i18n SDK', () => {
    const src = readFileSync(ENTRY, 'utf8');
    expect(src).not.toMatch(STATIC_IMPORT);
  });

  it('entry point uses await import() for the rpiv-i18n SDK', () => {
    const src = readFileSync(ENTRY, 'utf8');
    expect(src).toMatch(DYNAMIC_IMPORT);
  });

  it('entry point guards the dynamic import with try/catch', () => {
    const src = readFileSync(ENTRY, 'utf8');
    expect(src).toMatch(/\btry\s*\{[\s\S]*?\bcatch\b/);
  });
});

// Held in a variable so TypeScript treats the specifier as dynamic — a literal
// string here would trip TS2307 ("cannot find module") at compile time even
// though the test deliberately wants the resolution to fail at runtime.
const MISSING_SDK_SPECIFIER = '@juicesharp/__definitely-not-installed__';

describe('i18n soft-peer shim — runtime fallback contract', () => {
  it('await import() of a non-existent specifier rejects (catchable)', async () => {
    // Foundation of the entire fallback: Node's spec contract that a
    // dynamic import of a missing module rejects with an error we can
    // catch, instead of (e.g.) returning an empty namespace or hanging.
    await expect(import(MISSING_SDK_SPECIFIER)).rejects.toThrow();
  });

  it('the real bridge loads and falls back to English when the SDK is not installed', async () => {
    // Fork: this repo doesn't install @juicesharp/rpiv-i18n, so this exercises the production path.
    vi.doUnmock(SDK_SPECIFIER);
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { t, isMissingModule } = await import('./i18n-bridge.js');
    await import('../index.js');
    expect(t('any.key', 'literal fallback')).toBe('literal fallback');
    expect(t('sentinel.next', 'Next')).toBe('Next');
    expect(warn).not.toHaveBeenCalled(); // absent is the normal case: no noise
    // Absent SDK, as Node, jiti and Vite word it: silent.
    expect(isMissingModule(new Error("Cannot find package '@juicesharp/rpiv-i18n' imported from /x/a.js"))).toBe(true);
    expect(isMissingModule(new Error("Cannot find module '@juicesharp/rpiv-i18n/loader'"))).toBe(true);
    expect(isMissingModule(new Error('Could not resolve "@juicesharp/rpiv-i18n" imported by "x"'))).toBe(true);
    // Installed but broken: reported.
    expect(
      isMissingModule(
        new Error("Cannot find package 'dep' imported from /n/node_modules/@juicesharp/rpiv-i18n/i18n.js"),
      ),
    ).toBe(false);
    expect(isMissingModule(new SyntaxError('Unexpected token'))).toBe(false);
  });
});
