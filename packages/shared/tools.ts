import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Tools registered with `exposure: 'deferred'` stay out of the system prompt and are found
 * through pi's built-in `tool_search`. When `tool_search` is not active they would be
 * unreachable, so declare them directly instead. Call from `session_start`.
 * shortcut: this also re-declares tools a user left out with `--tools`; check the CLI selection if that matters.
 */
export function declareUnlessSearchable(
  pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>,
  names: readonly string[],
): void {
  const active = pi.getActiveTools();
  if (active.includes('tool_search')) return;
  const missing = names.filter((name) => !active.includes(name));
  if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
}
