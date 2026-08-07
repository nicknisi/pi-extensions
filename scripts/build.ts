/**
 * Compile every workspace package to `packages/<name>/dist/`.
 *
 * Why this exists: pi loads extensions through jiti, which transpiles
 * TypeScript on the fly, so these packages work fine shipping raw `.ts`.
 * Node itself does not — it refuses to strip types inside `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). So any consumer that is
 * *not* pi — a tsc-built CLI, a bundler, anything importing the package
 * directly — crashes on the raw sources. Publishing compiled JS alongside
 * them fixes that without taking anything away: `exports` points at
 * `dist/`, while the `pi` manifest still points at `index.ts` so local
 * path installs (`pi install ../pi-extensions/packages/foo`) keep working
 * with no build step.
 *
 * Implementation note: compiler options live in exactly one place, the root
 * tsconfig.json. This writes a throwaway config *inside* each package that
 * extends it and flips on emit. It has to live in the package dir rather
 * than a temp dir — `types`, `extends`, and `include` all resolve relative
 * to the config file, and a config in /tmp cannot find @types/node.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
const TSGO = join(root, 'node_modules', '.bin', 'tsgo');

/** Throwaway per-package build config. Git-ignored; removed in `finally`. */
const CONFIG_NAME = '.tsconfig.build.json';

const BUILD_CONFIG = {
  extends: '../../tsconfig.json',
  compilerOptions: {
    noEmit: false,
    declaration: true,
    rootDir: '.',
    outDir: './dist',
    // Drop the root's intra-repo source mapping. It exists so the no-emit
    // typecheck works on a fresh clone, but during emit it would pull a
    // dependency's sources into this program and violate rootDir. Here we
    // want the real thing: resolve siblings through their published
    // `exports`, which also proves their declaration emit is usable.
    paths: {},
  },
  // Every package is flat, so a non-recursive glob is enough — and it keeps
  // `dist/` (and its .d.ts files) out of the input set on rebuilds.
  include: ['./*.ts'],
  exclude: ['./dist'],
};

/** Package dir name -> npm name, for every workspace package. */
function workspacePackages(): Map<string, string> {
  const entries = readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, 'package.json')))
    .map((e) => e.name)
    .sort();
  return new Map(
    entries.map((dir) => {
      const pkg = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf-8')) as { name: string };
      return [dir, pkg.name];
    }),
  );
}

/**
 * Dependency-first build order. Siblings resolve through `exports` to
 * `dist/index.d.ts`, so a package's workspace dependencies must already be
 * emitted before it compiles.
 */
function buildOrder(packages: Map<string, string>): string[] {
  const dirByName = new Map([...packages].map(([dir, name]) => [name, dir]));
  const ordered: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (dir: string): void => {
    const status = state.get(dir);
    if (status === 'done') return;
    if (status === 'visiting') throw new Error(`dependency cycle at packages/${dir}`);
    state.set(dir, 'visiting');

    const pkg = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const depDir = dirByName.get(dep);
      if (depDir !== undefined) visit(depDir);
    }

    state.set(dir, 'done');
    ordered.push(dir);
  };

  for (const dir of packages.keys()) visit(dir);
  return ordered;
}

function build(name: string): boolean {
  const dir = join(packagesDir, name);
  const configPath = join(dir, CONFIG_NAME);

  rmSync(join(dir, 'dist'), { recursive: true, force: true });
  writeFileSync(configPath, `${JSON.stringify(BUILD_CONFIG, null, 2)}\n`);
  try {
    const result = spawnSync(TSGO, ['-p', configPath], { cwd: dir, stdio: 'inherit' });
    return result.status === 0;
  } finally {
    rmSync(configPath, { force: true });
  }
}

/**
 * Guard the contract the whole build rests on: `exports` must point into
 * `dist/`, `files` must ship it, and the `pi` manifest must keep pointing at
 * the sources so local path installs need no build.
 */
function verify(name: string): string[] {
  const dir = join(packagesDir, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
    exports?: unknown;
    files?: unknown;
    pi?: { extensions?: unknown };
  };
  const problems: string[] = [];

  const entry = (pkg.exports as { '.'?: { default?: string } })?.['.']?.default;
  if (entry === undefined) {
    problems.push('exports["."].default is missing');
  } else if (!existsSync(join(dir, entry))) {
    problems.push(`exports entry ${entry} was not emitted`);
  }

  if (!Array.isArray(pkg.files) || !pkg.files.includes('dist')) {
    problems.push('files is missing "dist"');
  }

  const piExtensions = pkg.pi?.extensions;
  if (Array.isArray(piExtensions) && piExtensions.some((p) => String(p).startsWith('./dist/'))) {
    problems.push('pi.extensions points at dist/ — it must stay on the sources');
  }

  return problems;
}

const names = buildOrder(workspacePackages());
const failed: string[] = [];

for (const name of names) {
  if (!build(name)) {
    failed.push(`${name}: compile failed`);
    continue;
  }
  for (const problem of verify(name)) failed.push(`${name}: ${problem}`);
}

if (failed.length > 0) {
  console.error(`\nBuild failed:\n${failed.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}

console.log(`Built ${names.length} packages.`);
