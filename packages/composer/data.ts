/**
 * Footer data that pi doesn't hand to extensions directly: Anthropic plan
 * usage (5h / 7d windows), the open PR for the current branch, and session
 * totals (cost, lines changed). Moved from the retired statusline package.
 *
 * Nothing here blocks the render path: network and subprocess work runs
 * async, results land in caches, and a callback asks for a repaint.
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Asked for a repaint when async data arrives. Set by the extension entry. */
let onDataUpdated: (() => void) | undefined;
export function setDataListener(fn: (() => void) | undefined): void {
  onDataUpdated = fn;
}

// ─── Usage (Anthropic OAuth API) ──────────────────────────────────────────

const USAGE_CACHE_TTL_S = 120;
// In pi's agent dir (owned by the user), not a shared temp dir another user could pre-create.
const usageCacheDir = () => join(getAgentDir(), 'cache');
const usageCacheFile = () => join(usageCacheDir(), 'composer-usage.json');

export interface UsageWindow {
  utilization: number;
  resets_at: string;
}
export interface UsageData {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
}

/** Why usage is or isn't showing, reported by /composer. */
export let usageHealth = 'not requested yet';
let usageInFlight = false;
/** After a failed refresh, wait this long before asking again (no hammering a 429, no keychain prompts). */
let usageRetryAt = 0;

const isWindow = (w: unknown): w is UsageWindow =>
  typeof w === 'object' &&
  w !== null &&
  Number.isFinite((w as UsageWindow).utilization) &&
  typeof (w as UsageWindow).resets_at === 'string';

/** A usage payload with both windows, or undefined. */
export function parseUsage(raw: unknown): UsageData | undefined {
  const d = raw as Partial<UsageData> | null;
  return d && isWindow(d.five_hour) && isWindow(d.seven_day) ? (d as UsageData) : undefined;
}

async function oauthToken(): Promise<string | undefined> {
  try {
    const auth = JSON.parse(readFileSync(join(getAgentDir(), 'auth.json'), 'utf8'));
    if (auth?.anthropic?.access) return auth.anthropic.access;
  } catch {
    /* fall through to the keychain */
  }
  try {
    const { stdout } = await execFileP('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      timeout: 2000,
    });
    return JSON.parse(stdout.trim())?.claudeAiOauth?.accessToken;
  } catch {
    return undefined;
  }
}

/**
 * The cache dir must be a real directory (not a symlink) owned by this user
 * and not writable by group or others; otherwise the cache is not used.
 */
export function cacheDirIsPrivate(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    return (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function readUsageCache(allowStale: boolean): UsageData | undefined {
  if (!cacheDirIsPrivate(usageCacheDir())) return undefined;
  try {
    const file = usageCacheFile();
    const ageS = (Date.now() - statSync(file).mtimeMs) / 1000;
    if (!allowStale && ageS >= USAGE_CACHE_TTL_S) return undefined;
    return parseUsage(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

function failUsage(reason: string): void {
  usageHealth = reason;
  usageRetryAt = Date.now() + USAGE_CACHE_TTL_S * 1000;
}

function refreshUsage(): void {
  if (usageInFlight || Date.now() < usageRetryAt) return;
  usageInFlight = true;
  void (async () => {
    try {
      const token = await oauthToken();
      if (!token) return failUsage('no Anthropic OAuth token (pi auth.json or Claude Code keychain)');
      // In-process, so the token never appears in a process list.
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(3000),
      });
      const body = await res.text();
      if (res.status !== 200) return failUsage(`usage API answered HTTP ${res.status}`);
      if (!parseUsage(JSON.parse(body))) return failUsage('usage API response was missing a 5h or 7d window');
      mkdirSync(usageCacheDir(), { recursive: true, mode: 0o700 });
      if (!cacheDirIsPrivate(usageCacheDir())) return failUsage(`usage cache dir ${usageCacheDir()} is not private`);
      // Exclusive-create a temp file, then rename over the target: atomic, and
      // neither step follows a link planted at either name.
      const tmp = `${usageCacheFile()}.${process.pid}.tmp`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, usageCacheFile());
      usageHealth = 'ok';
      usageRetryAt = 0;
      memo = undefined;
      onDataUpdated?.();
    } catch (error) {
      failUsage(`usage fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      usageInFlight = false;
    }
  })();
}

// Renders run up to ~12×/s while animating; look at the cache file at most every 5s.
let memo: { at: number; data: UsageData | undefined } | undefined;

/** Cached usage; kicks an async refresh when stale. Never does I/O beyond a cache read. */
export function getUsage(ctx: ExtensionContext): UsageData | undefined {
  if (ctx.model?.provider !== 'anthropic') {
    usageHealth = 'only shown for Anthropic models';
    return undefined;
  }
  const now = Date.now();
  if (memo && now - memo.at < 5000) return memo.data;
  const fresh = readUsageCache(false);
  if (!fresh) refreshUsage();
  memo = { at: now, data: fresh ?? readUsageCache(true) };
  return memo.data;
}

export function timeUntil(iso: string, now = Date.now()): string {
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return '?';
  if (now >= end) return 'now';
  const mins = Math.floor((end - now) / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${mins % 60}m`;
  return `${mins}m`;
}

// ─── Pull request for the current branch (gh, cached) ─────────────────────

export interface PrInfo {
  number: number;
  url: string;
}
const PR_TTL_MS = 60_000;
const prCache = new Map<string, { info: PrInfo | null; expires: number }>();
let prInFlight: string | undefined;

/** Cached PR for `branch`; refreshes in the background when stale. */
export function getPr(branch: string, cwd: string): PrInfo | null {
  const cached = prCache.get(branch);
  if (cached && cached.expires > Date.now()) return cached.info;
  if (prInFlight !== branch) {
    prInFlight = branch;
    execFile(
      'gh',
      ['pr', 'view', '--json', 'number,url', '--jq', '"\\(.number)\\t\\(.url)"'],
      { timeout: 8000, cwd },
      (err, stdout) => {
        prInFlight = undefined;
        let info: PrInfo | null = null;
        if (!err) {
          const [num, url] = stdout.trim().split('\t');
          if (num && url) info = { number: Number.parseInt(num, 10), url };
        }
        // Misses are cached too, so a branch without a PR doesn't refetch every frame.
        prCache.set(branch, { info, expires: Date.now() + PR_TTL_MS });
        onDataUpdated?.();
      },
    );
  }
  return cached?.info ?? null;
}

// ─── Session totals ───────────────────────────────────────────────────────

export interface Totals {
  cost: number;
  added: number;
  removed: number;
}

/** Count changed lines in pi's edit diff (`+12 text` / `-12 text` rows). */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (/^\+\s*\d+ /.test(line)) added++;
    else if (/^-\s*\d+ /.test(line)) removed++;
  }
  return { added, removed };
}

type BranchEntry = ReturnType<ExtensionContext['sessionManager']['getBranch']>[number];

/** Cost and lines changed across the current branch. */
export function computeTotals(entries: readonly BranchEntry[]): Totals {
  const totals: Totals = { cost: 0, added: 0, removed: 0 };
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'assistant') totals.cost += (message as AssistantMessage).usage?.cost?.total ?? 0;
    if (message.role !== 'toolResult') continue;
    const details = message.details as Record<string, unknown> | undefined;
    if (!details || typeof details !== 'object') continue;
    // pi's edit tool reports a display diff; other tools may report counts directly.
    if (typeof details.diff === 'string') {
      const counted = countDiffLines(details.diff);
      totals.added += counted.added;
      totals.removed += counted.removed;
    } else {
      if (typeof details.linesAdded === 'number') totals.added += details.linesAdded;
      if (typeof details.linesRemoved === 'number') totals.removed += details.linesRemoved;
    }
  }
  return totals;
}
