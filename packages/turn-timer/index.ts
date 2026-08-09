/**
 * Turn Timer Extension
 *
 * Shows how long a complete run took — from the moment you send a message
 * until the agent settles and is awaiting your next message. This spans
 * every LLM response, tool call, and tool result in the run, so a turn
 * with multiple tool-call rounds still produces a single timer row.
 *
 * Uses agent_start/agent_settled and renders the result as a custom
 * transcript entry that does NOT participate in LLM context, so it never
 * pollutes the conversation and /copy (which reads only assistant message
 * text) never picks it up.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

const CUSTOM_TYPE = 'turn-duration';

/** Format seconds as a compact human string: "0.8s", "12.3s", "1m 23s". */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export default function turnTimer(pi: ExtensionAPI) {
  // ── Render the timer row: a quiet dim line ───────────────────────────
  pi.registerEntryRenderer(CUSTOM_TYPE, (entry, _opts, theme) => {
    const data = entry.data as { seconds: number };
    const label = theme.fg('dim', `· ${formatDuration(data.seconds)}`);
    return new Text(label, 0, 0);
  });

  // ── Time each complete run (all turns until the agent settles) ──────
  // agent_start fires when the run begins; agent_settled fires when the
  // agent is idle and won't continue automatically (no retry/compaction/
  // follow-up remaining). This yields one row per user message, not one
  // per tool-call round.
  let start: number | undefined;

  pi.on('agent_start', () => {
    start = Date.now();
  });

  pi.on('agent_settled', () => {
    if (start === undefined) return;
    const seconds = (Date.now() - start) / 1000;
    start = undefined;
    pi.appendEntry(CUSTOM_TYPE, { seconds });
  });
}
