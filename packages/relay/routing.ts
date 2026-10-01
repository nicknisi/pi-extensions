import type { Letter } from './mailbox.js';
import type { SessionRecord } from './registry.js';

/** Exact session IDs share the target namespace with names and addresses. Never guess collisions. */
export function resolveSessionTarget(
  to: string,
  records: SessionRecord[],
  selfAddr: string,
): { record?: SessionRecord; error?: string } {
  const peers = records.filter((r) => r.addr !== selfAddr);
  const exact = peers.filter((r) => r.sessionId === to || r.addr === to || r.name.toLowerCase() === to.toLowerCase());
  const matches = exact.length ? exact : peers.filter((r) => r.addr.startsWith(to));
  const label = (r: SessionRecord) =>
    `${JSON.stringify(r.name)} (address ${r.addr}, sessionId ${JSON.stringify(r.sessionId)})`;
  if (!matches.length)
    return { error: `No session matches ${JSON.stringify(to)}. Use list or list-cwd to discover peers.` };
  if (matches.length > 1)
    return {
      error: `${JSON.stringify(to)} is ambiguous: ${matches.map(label).join(', ')}. Use the intended full address.`,
    };
  return { record: matches[0]! };
}

interface ReplyTarget {
  id: string;
  addr: string;
  ask: boolean;
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const ADDRESS = /^[a-f0-9]{12}$/;

/** Reconstruct ordinary reply targets from the active branch, not abandoned histories or process-local delivery state. */
export function resolveReplyTarget(
  reference: string,
  pending: Letter[],
  branch: readonly unknown[],
): { target?: ReplyTarget; error?: string } {
  if (!ID.test(reference)) return { error: 'replyTo must be a message ID or a nonempty unique prefix.' };
  const candidates: ReplyTarget[] = pending.map((ask) => ({ id: ask.id, addr: ask.from.addr, ask: true }));
  for (const entry of branch) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== 'custom_message' || e.customType !== 'relay:delivery') continue;
    const d = e.details;
    if (typeof d !== 'object' || d === null) continue;
    const data = d as Record<string, unknown>;
    if (data.kind !== 'message' && data.kind !== 'reply') continue;
    if (typeof data.id !== 'string' || !ID.test(data.id) || typeof data.from !== 'object' || data.from === null)
      continue;
    const addr = (data.from as Record<string, unknown>).addr;
    if (typeof addr !== 'string' || !ADDRESS.test(addr)) continue;
    candidates.push({ id: data.id, addr, ask: false });
  }
  const matches = new Map<string, ReplyTarget>();
  const exact = candidates.filter((candidate) => candidate.id === reference);
  for (const candidate of exact.length ? exact : candidates) {
    if (!candidate.id.startsWith(reference)) continue;
    const key = `${candidate.id}\0${candidate.addr}`;
    matches.set(key, { ...candidate, ask: candidate.ask || matches.get(key)?.ask === true });
  }
  if (!matches.size)
    return {
      error: `No received message or pending ask matches ${JSON.stringify(reference)} in the active conversation. Use its full ID or list pending asks.`,
    };
  if (matches.size !== 1)
    return {
      error: `Reply ID ${JSON.stringify(reference)} is ambiguous. Use a longer prefix or full ID. Sender addresses: ${[...new Set([...matches.values()].map((m) => m.addr))].join(', ')}.`,
    };
  return { target: matches.values().next().value! };
}
