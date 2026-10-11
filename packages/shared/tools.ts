import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Tools registered with `exposure: 'deferred'` stay out of the system prompt and are found
 * through pi's built-in `tool_search`. When `tool_search` is not active they would be
 * unreachable, so declare them directly instead. Call from `session_start`.
 *
 * Only tools pi still has registered are declared: an explicit `--tools` allowlist or
 * `--exclude-tools` drops unnamed extension tools from the registry (`getAllTools()`), so
 * the fallback never re-enables a tool the user left out.
 */
export function declareUnlessSearchable(
  pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools' | 'getAllTools'>,
  names: readonly string[],
): void {
  const active = pi.getActiveTools();
  if (active.includes('tool_search')) return;
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  const missing = names.filter((name) => registered.has(name) && !active.includes(name));
  if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
}
