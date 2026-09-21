#!/usr/bin/env node
/**
 * Approved-path write boundary check.
 *
 * `capture` snapshots content hashes of every Git-visible file OUTSIDE the
 * approved allowlist (including the two pre-existing dirty user files) into a
 * pre-implementation baseline. `check` recomputes and reports any file added,
 * removed, or modified outside the allowlist, so unrelated tracked or untracked
 * work cannot be silently changed by this project.
 *
 * The baseline is local evidence (git-ignored) captured once before
 * implementation. It is never overwritten by `check`, and discrepancies are
 * reported rather than restored. A missing baseline is a failure.
 *
 * Usage:
 *   node packages/checkpoint/verify/boundary.mjs capture
 *   node packages/checkpoint/verify/boundary.mjs check
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Baseline location and repo root are overridable so the utility can be
// exercised against an isolated temporary Git fixture in tests.
const BASELINE = process.env.SELF_COMPACT_BOUNDARY_BASELINE ?? join(HERE, 'results', 'boundary-baseline.json');

function repoRoot() {
  const override = process.env.SELF_COMPACT_BOUNDARY_ROOT;
  if (override) return resolve(override);
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

/** Paths that this project is allowed to create or modify. */
function isAllowlisted(path) {
  if (path.startsWith('packages/checkpoint/')) return true;
  if (path.startsWith('docs/ideation/self-compact/')) return true;
  if (path === 'README.md') return true;
  if (path === 'pnpm-lock.yaml') return true;
  // Only this project's generated changeset, not the whole .changeset directory.
  if (/^\.changeset\/.*self-compact.*\.md$/.test(path)) return true;
  return false;
}

/** Every Git-visible (tracked or untracked, non-ignored) file, repo-relative. */
function gitVisibleFiles(root) {
  const out = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hashFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/** Snapshot of files outside the allowlist: { relPath: sha256 }. */
function snapshot(root) {
  const files = {};
  for (const rel of gitVisibleFiles(root)) {
    if (isAllowlisted(rel)) continue;
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue; // deleted-but-listed; treated as removed below
    files[rel] = hashFile(abs);
  }
  return files;
}

function capture() {
  const root = repoRoot();
  if (existsSync(BASELINE)) {
    console.error(`boundary: baseline already exists at ${relative(root, BASELINE)}; refusing to overwrite it.`);
    process.exit(1);
  }
  mkdirSync(dirname(BASELINE), { recursive: true });
  const files = snapshot(root);
  const payload = { version: 1, capturedAt: new Date().toISOString(), files };
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`boundary: captured ${Object.keys(files).length} files into ${relative(root, BASELINE)}`);
}

function check() {
  const root = repoRoot();
  if (!existsSync(BASELINE)) {
    console.error('boundary: missing baseline. Run `node packages/checkpoint/verify/boundary.mjs capture` first.');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).files ?? {};
  const current = snapshot(root);

  const problems = [];
  for (const [path, hash] of Object.entries(current)) {
    if (!(path in baseline)) problems.push(`added outside allowlist: ${path}`);
    else if (baseline[path] !== hash) problems.push(`modified outside allowlist: ${path}`);
  }
  for (const path of Object.keys(baseline)) {
    if (!(path in current)) problems.push(`removed outside allowlist: ${path}`);
  }

  if (problems.length > 0) {
    console.error(`boundary: ${problems.length} discrepancy(ies) outside the approved paths:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`boundary: OK (${Object.keys(current).length} unrelated files unchanged).`);
}

const command = process.argv[2];
if (command === 'capture') capture();
else if (command === 'check') check();
else {
  console.error('usage: boundary.mjs <capture|check>');
  process.exit(1);
}
