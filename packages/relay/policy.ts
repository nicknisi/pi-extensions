/**
 * Loop-breaking and inbound policy. Pi-free.
 *
 * A loop between two agents must terminate independently of what either
 * model decides: repeats, rate, and backlog are all capped here, at the
 * transport, not in the prompts.
 */

import { MAX_BODY_CHARS } from './mailbox.js';

export const DEDUPE_WINDOW_MS = 10_000;
export const RATE_LIMIT_MAX = 8;
export const RATE_LIMIT_WINDOW_MS = 30_000;
export const BACKLOG_CAP = 50;

export type OutboundVerdict = { ok: true } | { ok: false; reason: string };

export class OutboundPolicy {
  private readonly sentAt: number[] = [];
  private readonly recentBodies = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Gate one outbound letter. `unreadBacklog` is the target's current
   * unread count (report 0 when the target is idle — an idle agent has by
   * definition worked through what it was handed).
   */
  check(body: string, unreadBacklog: number): OutboundVerdict {
    if (body.length > MAX_BODY_CHARS) {
      return {
        ok: false,
        reason: `Message is ${body.length} chars; cap is ${MAX_BODY_CHARS}. Send a summary and a path, not a payload.`,
      };
    }
    if (unreadBacklog >= BACKLOG_CAP) {
      return {
        ok: false,
        reason: `Peer has ${unreadBacklog} unread messages (cap ${BACKLOG_CAP}); wait for it to drain.`,
      };
    }
    const now = this.now();
    const lastSame = this.recentBodies.get(body);
    if (lastSame !== undefined && now - lastSame < DEDUPE_WINDOW_MS) {
      return { ok: false, reason: 'Identical message sent less than 10s ago — dropped to break loops.' };
    }
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    while (this.sentAt.length > 0 && this.sentAt[0]! < windowStart) this.sentAt.shift();
    if (this.sentAt.length >= RATE_LIMIT_MAX) {
      return {
        ok: false,
        reason: `Rate limited: ${RATE_LIMIT_MAX} messages per ${RATE_LIMIT_WINDOW_MS / 1000}s per session.`,
      };
    }
    return { ok: true };
  }

  /** Record a successful send so dedupe/rate state stays current. */
  recordSend(body: string): void {
    this.sentAt.push(this.now());
    this.recentBodies.set(body, this.now());
    // bound the dedupe map
    if (this.recentBodies.size > 200) {
      const cutoff = this.now() - DEDUPE_WINDOW_MS;
      for (const [key, ts] of this.recentBodies) {
        if (ts < cutoff) this.recentBodies.delete(key);
      }
    }
  }
}

/** Inbound guard: PI_RELAY_INBOUND=refuse drops all peer mail. */
export function inboundAccepts(env: string | undefined = process.env.PI_RELAY_INBOUND): boolean {
  return env !== 'refuse';
}
