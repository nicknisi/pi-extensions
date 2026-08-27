/**
 * adr — inject the repo's ADR index into the system prompt.
 *
 * When any ancestor of cwd contains docs/decisions/, its numbered filenames
 * (the "veto list") are appended to the system prompt on before_agent_start.
 * Full ADRs are read on demand by the agent; only paths ride the prompt.
 *
 * Conventions:
 *  - ADRs are NNNN-kebab-title.md directly in docs/decisions/
 *  - superseded ADRs move to docs/decisions/superseded/ (excluded by the
 *    non-recursive readdir — no status parsing)
 *  - template files (0000-*) are excluded
 *
 * Recomputed per prompt, so the index is never stale within a session.
 * No-ops when no docs/decisions/ exists.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const ADR_DIR = join('docs', 'decisions');
const ADR_FILE = /^\d{4}-.+\.md$/;

/** Walk up from `start` to the filesystem root; first docs/decisions/ wins. */
export function findAdrDir(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, ADR_DIR);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Active ADR filenames, sorted by number. Templates excluded. */
export function listAdrs(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => ADR_FILE.test(f) && !f.startsWith('0000-'))
    .sort();
}

const FRAMING = `## Decision records

This repo has ADRs in docs/decisions/. These are settled decisions: read the relevant file before proposing or changing anything it touches, and do not contravene one without asking, unless the user explicitly overrides.`;

export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', (event, ctx) => {
    const dir = findAdrDir(ctx.cwd);
    if (!dir) return;
    const adrs = listAdrs(dir);
    if (adrs.length === 0) return;
    const list = adrs.map((f) => `- docs/decisions/${f}`).join('\n');
    return { systemPrompt: `${event.systemPrompt}\n\n${FRAMING}\n\n${list}` };
  });
}
