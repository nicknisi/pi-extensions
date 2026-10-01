import * as path from 'node:path';
import { listRecords, presenceOf, type Presence, type SessionRecord } from './registry.js';

export type PresenceFilter = 'all' | 'online' | 'live' | 'stalled' | 'offline';

export interface RelayDiscoveryArguments {
  action: 'list' | 'list-cwd';
  cwd?: string;
  includeSubdirectories?: boolean;
  sessionIds?: string[];
  presence?: PresenceFilter;
  limit?: number;
  offset?: number;
}

export type RelayDiscoveryInput = RelayDiscoveryArguments & {
  readonly root: string;
  readonly selfAddress: string;
  readonly activeCwd: string;
  readonly now?: number;
};

export interface RelayDiscoverySession {
  readonly sessionId: string;
  readonly address: string;
  readonly name: string;
  readonly cwd: string;
  readonly presence: Presence;
  readonly activity: SessionRecord['status'];
}

export interface RelayDiscoveryDetails {
  readonly outcome: 'success';
  readonly action: 'list' | 'list-cwd';
  readonly total: number;
  readonly offset: number;
  readonly returned: number;
  readonly sessions: readonly RelayDiscoverySession[];
  /** Requested sessionIds that are not registered or were excluded by cwd/presence. */
  readonly missingSessionIds: readonly string[];
  readonly hasMore: boolean;
  readonly nextArguments?: Record<string, unknown>;
}

export const DISCOVERY_DEFAULT_LIMIT = 20;
export const DISCOVERY_MAX_LIMIT = 100;
const DISPLAY_MAX_CHARS = 96;
const PRESENCE_RANK: Record<Presence, number> = { live: 0, stalled: 1, offline: 2 };

/** Strip terminal escapes/control characters and cap length — names and cwds are peer-controlled. */
function display(value: string): string {
  // oxlint-disable-next-line no-control-regex
  const cleaned = value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  return collapsed.length <= DISPLAY_MAX_CHARS ? collapsed : `${collapsed.slice(0, DISPLAY_MAX_CHARS - 1)}…`;
}

function matchesPresence(presence: Presence, filter: PresenceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'online') return presence !== 'offline';
  return presence === filter;
}

function inCwd(recordCwd: string, cwd: string, includeSubdirectories: boolean): boolean {
  if (!includeSubdirectories) return recordCwd === cwd;
  const relative = path.relative(path.resolve(cwd), path.resolve(recordCwd));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Bounded session discovery. Online sessions sort first, then most recently
 * seen, so the default page shows reachable peers without hiding offline
 * mailboxes (mail to a closed session is a first-class use case).
 */
export function discoverRelaySessions(input: RelayDiscoveryInput): { text: string; details: RelayDiscoveryDetails } {
  const limit = input.limit ?? DISCOVERY_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_MAX_LIMIT)
    throw new Error(`limit must be an integer from 1 to ${DISCOVERY_MAX_LIMIT}.`);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');

  const now = input.now ?? Date.now();
  const cwd = input.action === 'list-cwd' ? (input.cwd ?? input.activeCwd) : input.cwd;
  const includeSubdirectories = input.includeSubdirectories !== false;
  const filter = input.presence ?? 'all';
  const wanted = input.sessionIds ? new Set(input.sessionIds) : undefined;

  const matching = listRecords(input.root)
    .filter((r) => (wanted ? wanted.has(r.sessionId) : r.addr !== input.selfAddress))
    .filter((r) => cwd === undefined || inCwd(r.cwd, cwd, includeSubdirectories))
    .map((record) => ({ record, presence: presenceOf(record, now) }))
    .filter(({ presence }) => matchesPresence(presence, filter))
    .sort(
      (a, b) =>
        PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence] ||
        b.record.lastSeenAt - a.record.lastSeenAt ||
        a.record.addr.localeCompare(b.record.addr),
    );

  const sessions = matching.slice(offset, offset + limit).map(({ record, presence }): RelayDiscoverySession => ({
    sessionId: record.sessionId,
    address: record.addr,
    name: display(record.name),
    cwd: display(record.cwd),
    presence,
    activity: record.status,
  }));
  const found = new Set(matching.map(({ record }) => record.sessionId));
  const missingSessionIds = input.sessionIds?.filter((id) => !found.has(id)) ?? [];
  const hasMore = offset + sessions.length < matching.length;
  const nextArguments = hasMore
    ? {
        action: input.action,
        ...(input.cwd !== undefined && { cwd: input.cwd }),
        ...(input.includeSubdirectories !== undefined && { includeSubdirectories: input.includeSubdirectories }),
        ...(input.sessionIds !== undefined && { sessionIds: input.sessionIds }),
        ...(input.presence !== undefined && { presence: input.presence }),
        limit,
        offset: offset + sessions.length,
      }
    : undefined;

  const scope =
    cwd === undefined ? '' : ` in ${includeSubdirectories ? 'cwd subtree' : 'cwd'} ${JSON.stringify(display(cwd))}`;
  const lines = [
    `${matching.length} session${matching.length === 1 ? '' : 's'}${scope}${filter === 'all' ? '' : ` (presence=${filter})`}; showing ${sessions.length === 0 ? 'none' : `${offset + 1}-${offset + sessions.length}`}.`,
    ...sessions.map(
      (s) =>
        `sessionId=${JSON.stringify(s.sessionId)} address=${s.address} presence=${s.presence} activity=${s.activity} name=${JSON.stringify(s.name)}${cwd === undefined || s.cwd !== cwd ? ` cwd=${JSON.stringify(s.cwd)}` : ''}`,
    ),
  ];
  if (missingSessionIds.length > 0)
    lines.push(
      `Not found (unregistered or filtered out): ${missingSessionIds.map((id) => JSON.stringify(id)).join(', ')}`,
    );
  if (nextArguments) lines.push(`More sessions available. Continue with ${JSON.stringify(nextArguments)}.`);

  return {
    text: lines.join('\n'),
    details: {
      outcome: 'success',
      action: input.action,
      total: matching.length,
      offset,
      returned: sessions.length,
      sessions,
      missingSessionIds,
      hasMore,
      ...(nextArguments && { nextArguments }),
    },
  };
}
