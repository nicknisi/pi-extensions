/**
 * Ultracode: let the model reach for workflows on its own.
 *
 * - Session mode (`/ultracode`, `--ultracode`, or `"ultracode": true` in
 *   ~/.pi/agent/configs/workflows.json) adds a system prompt section asking for
 *   a workflow on every substantive task.
 * - The `ultracode` keyword in a prompt you type opts that one task in.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ULTRACODE_SECTION = 'ultracode';

const HOW = [
  'Write a workflow script whose agents do the work instead of working through it turn by turn:',
  'fan out one agent per independent item (file, route, module, source); have independent agents',
  'verify or adversarially review findings before you report them; use worktree: true for parallel',
  'edits and integrate the patches; and break large changes into separate workflows that understand,',
  'change, then verify. Start the run, then end your turn; its result arrives as a message.',
].join(' ');

export const ULTRACODE_GUIDANCE = [
  'Ultracode is on: for every substantive task — multi-file changes, migrations, audits, reviews,',
  'research, anything with independent parts — plan and run it with the `workflow` tool.',
  HOW,
  'Skip workflows for trivial requests (renames, one-line fixes, quick questions).',
].join(' ');

export const ULTRACODE_KEYWORD_GUIDANCE = [
  'The user asked for this task to run as a workflow (ultracode): plan and run it with the `workflow` tool.',
  HOW,
].join(' ');

const KEYWORD = /(^|[^\w-])ultracode(?![\w-])/i;

/** True when a prompt opts its task into a workflow. Slash commands never do. */
export function hasUltracodeKeyword(text: string): boolean {
  return !text.trimStart().startsWith('/') && KEYWORD.test(text);
}

/** `ultracode` from <agentDir>/configs/workflows.json; false when absent or malformed. */
export function ultracodeDefault(agentDir: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, 'configs', 'workflows.json'), 'utf8')) as unknown;
    return typeof raw === 'object' && raw !== null && (raw as { ultracode?: unknown }).ultracode === true;
  } catch {
    return false;
  }
}
