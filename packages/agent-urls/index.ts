import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.startsWith('~/')
  ? path.join(os.homedir(), process.env.PI_CODING_AGENT_DIR.slice(2))
  : process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

const MAX_SCAN_FILES = 2500;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LINES = 500;

// Optionals are widened with `| undefined`: these are parsed out of on-disk
// JSON, where a field may be absent or explicitly undefined.
interface RunRecord {
  runId: string;
  namespace: string;
  agent?: string | undefined;
  model?: string | undefined;
  promptPreview?: string | undefined;
  status?: string | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  durationMs?: number | undefined;
  usage?:
    | {
        input?: number | undefined;
        output?: number | undefined;
        cost?: number | undefined;
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        totalTokens?: number | undefined;
      }
    | undefined;
  output?: string | undefined;
  error?: string | undefined;
  toolCalls?: number | undefined;
  turns?: number | undefined;
  parentSessionId?: string | undefined;
  hostPid?: number | undefined;
}

interface LocatedRun {
  record: RunRecord;
  file: string;
  updatedAt: number;
}

function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Enumerate persisted run records under ~/.pi/agent/subagent-runs/<ns>/*.json
 * (written by @nicknisi/pi-shared's in-process runtime). Unreadable or
 * invalid files are skipped; a record missing `namespace` inherits its
 * directory name.
 */
function discoverRuns(): LocatedRun[] {
  const root = path.join(AGENT_DIR, 'subagent-runs');
  const runs: LocatedRun[] = [];
  let namespaces: string[];
  try {
    namespaces = fs.readdirSync(root).sort();
  } catch {
    return runs;
  }
  for (const namespace of namespaces) {
    const dir = path.join(root, namespace);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const name of files) {
      if (runs.length >= MAX_SCAN_FILES) break;
      const file = path.join(dir, name);
      let parsed: any;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed.runId !== 'string') continue;
      const record = parsed as RunRecord;
      if (typeof record.namespace !== 'string') record.namespace = namespace;
      runs.push({
        record,
        file,
        updatedAt: record.endedAt ?? record.startedAt ?? statMtime(file),
      });
    }
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt);
}

function short(text: string | undefined, max = 90): string {
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatDate(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'unknown';
}

function formatDuration(run: RunRecord): string {
  const ms = run.durationMs ?? (run.startedAt && run.endedAt ? run.endedAt - run.startedAt : undefined);
  if (ms === undefined) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatUsage(run: RunRecord): string {
  const u = run.usage;
  if (!u) return '';
  const input = u.input ?? u.inputTokens;
  const output = u.output ?? u.outputTokens;
  const parts = [
    input !== undefined ? `${input} in` : '',
    output !== undefined ? `${output} out` : '',
    u.cost !== undefined ? `$${u.cost.toFixed(4)}` : '',
  ].filter(Boolean);
  return parts.join(' / ');
}

function filterRuns(runs: LocatedRun[], query?: string): LocatedRun[] {
  const q = query?.toLowerCase().trim();
  if (!q) return runs;
  return runs.filter(({ record }) =>
    [record.runId, record.namespace, record.agent, record.model, record.status, record.promptPreview, record.output]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q)),
  );
}

function runUri(run: RunRecord): string {
  return `agent://${run.namespace}/${run.runId}`;
}

function formatRunList(runs: LocatedRun[], query?: string, limit = DEFAULT_LIMIT): string {
  const filtered = filterRuns(runs, query);
  const shown = filtered.slice(0, limit);
  if (!shown.length) return 'No subagent runs found.';
  const lines = [`Subagent runs (${shown.length}${filtered.length > shown.length ? ` of ${filtered.length}` : ''}):`];
  for (const { record } of shown) {
    const labels = [record.status, formatDuration(record)].filter(Boolean).join(', ');
    lines.push(`- ${runUri(record)}${labels ? ` (${labels})` : ''}`);
    const task = record.promptPreview;
    if (task) lines.push(`  ${record.agent ? `${record.agent}: ` : ''}${short(task)}`);
  }
  lines.push('', 'Read with: `/agent read agent://<namespace>/<runId>`');
  return lines.join('\n');
}

/**
 * Resolve a URI target: `agent://<runId>` searches across namespaces,
 * `agent://<namespace>/<runId>` scopes to one. Ids may be abbreviated to any
 * unique prefix.
 */
function resolveRun(idOrPrefix: string, namespace: string | undefined, runs: LocatedRun[]): LocatedRun {
  const scoped = namespace ? runs.filter((run) => run.record.namespace === namespace) : runs;
  const matches = scoped.filter((run) => run.record.runId === idOrPrefix || run.record.runId.startsWith(idOrPrefix));
  const scope = namespace ? ` in namespace '${namespace}'` : '';
  if (matches.length === 0) throw new Error(`No subagent run matched '${idOrPrefix}'${scope}. Try /agent list.`);
  if (matches.length > 1)
    throw new Error(
      `Ambiguous run id '${idOrPrefix}'${scope} matched: ${matches.map((r) => runUri(r.record)).join(', ')}`,
    );
  // Exactly one match remains after the guards above.
  return matches[0]!;
}

function truncate(text: string, maxLines = DEFAULT_MAX_LINES): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n\n[truncated: ${lines.length - maxLines} more line(s)]`;
}

function formatRunSummary(run: LocatedRun): string {
  const { record } = run;
  const lines = [`# ${runUri(record)}`, ''];
  lines.push(`- namespace: ${record.namespace}`);
  if (record.agent) lines.push(`- agent: ${record.agent}`);
  if (record.model) lines.push(`- model: ${record.model}`);
  if (record.status) lines.push(`- status: ${record.status}`);
  lines.push(`- started: ${formatDate(record.startedAt)}`);
  if (record.endedAt) lines.push(`- ended: ${formatDate(record.endedAt)}`);
  const duration = formatDuration(record);
  if (duration) lines.push(`- duration: ${duration}`);
  const usage = formatUsage(record);
  if (usage) lines.push(`- usage: ${usage}`);
  if (record.turns !== undefined) lines.push(`- turns: ${record.turns}`);
  if (record.toolCalls !== undefined) lines.push(`- toolCalls: ${record.toolCalls}`);
  if (record.parentSessionId) lines.push(`- parentSession: ${record.parentSessionId}`);
  if (record.promptPreview) lines.push(`- prompt: ${short(record.promptPreview, 140)}`);
  if (record.output) lines.push(`- output: ${runUri(record)}/output`);
  if (record.error) lines.push(`- error: ${runUri(record)}/error`);
  lines.push(`- record: ${run.file}`);
  return lines.join('\n');
}

function parseAgentUri(uri: string): {
  id?: string | undefined;
  namespace?: string | undefined;
  leaf?: string | undefined;
} {
  const match = uri.match(/^agent:\/\/(.*)$/);
  if (!match) throw new Error(`Unsupported URI '${uri}'. Use agent://<namespace>/<runId>.`);
  const parts = match[1]!.split('/').filter(Boolean);
  // One part is a runId (possibly abbreviated); two is namespace/runId —
  // unless the second part is a leaf keyword, in which case it's runId/leaf;
  // three is namespace/runId/leaf.
  const leaves = ['summary', 'output', 'result', 'error', 'raw', 'json'];
  if (parts.length >= 3) return { namespace: parts[0], id: parts[1], leaf: parts[2] };
  if (parts.length === 2) {
    if (leaves.includes(parts[1]!)) return { id: parts[0], leaf: parts[1] };
    return { namespace: parts[0], id: parts[1] };
  }
  return { id: parts[0] };
}

function readAgentUri(uri: string, maxLines = DEFAULT_MAX_LINES): string {
  const parsed = parseAgentUri(uri);
  const runs = discoverRuns();
  if (!parsed.id) return formatRunList(runs, undefined, DEFAULT_LIMIT);
  const run = resolveRun(parsed.id, parsed.namespace, runs);
  const { record } = run;
  const leaf = parsed.leaf || 'summary';
  if (leaf === 'summary') return formatRunSummary(run);
  if (leaf === 'output' || leaf === 'result') {
    if (!record.output) throw new Error(`No output recorded for ${uri}.`);
    return truncate(record.output, maxLines);
  }
  if (leaf === 'error') {
    if (!record.error) throw new Error(`No error recorded for ${uri}.`);
    return truncate(record.error, maxLines);
  }
  if (leaf === 'raw' || leaf === 'json') {
    return truncate(fs.readFileSync(run.file, 'utf-8'), maxLines);
  }
  throw new Error(`Unknown leaf '${leaf}' for ${uri}. Try summary, output, error, or raw.`);
}

function postCommandResult(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string) {
  ctx.ui.notify('Agent URL result shown.', 'info');
  pi.sendMessage({
    customType: 'agent-url',
    content: text,
    display: true,
    details: { kind: 'agent-url-command' },
  });
}

export default function agentUrls(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'list_agent_runs',
    label: 'List Agent Runs',
    description: 'List recent subagent runs persisted by the shared runtime and their agent:// URLs.',
    promptSnippet: 'List recent subagent runs before reading agent:// URLs.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional substring filter over run id, namespace, agent, status, prompt, and output.',
        },
        limit: {
          type: 'number',
          description: 'Maximum runs to return.',
          default: DEFAULT_LIMIT,
        },
      },
    },
    async execute(_id: string, params: { query?: string; limit?: number }) {
      const runs = discoverRuns();
      const text = formatRunList(runs, params.query, Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, 100)));
      return {
        content: [{ type: 'text', text }],
        details: {
          runs: filterRuns(runs, params.query)
            .slice(0, params.limit ?? DEFAULT_LIMIT)
            .map((run) => run.record),
        },
      };
    },
  });

  pi.registerTool({
    name: 'read_agent_url',
    label: 'Read Agent URL',
    description: 'Read agent:// URLs for persisted subagent runs: summaries, outputs, errors, and raw records.',
    promptSnippet: 'Read subagent run records via agent://<namespace>/<runId>.',
    parameters: {
      type: 'object',
      required: ['uri'],
      properties: {
        uri: {
          type: 'string',
          description: 'agent://<namespace>/<runId>[/summary|output|error|raw] — runId may be a unique prefix.',
        },
        maxLines: {
          type: 'number',
          description: 'Maximum rendered lines to return.',
          default: DEFAULT_MAX_LINES,
        },
      },
    },
    async execute(_id: string, params: { uri: string; maxLines?: number }) {
      const maxLines = Math.max(20, Math.min(params.maxLines ?? DEFAULT_MAX_LINES, 5000));
      const text = readAgentUri(params.uri, maxLines);
      return {
        content: [{ type: 'text', text }],
        details: { uri: params.uri },
      };
    },
  });

  pi.registerCommand('agent', {
    description: 'Inspect subagent runs: /agent list [query] | /agent read agent://<namespace>/<runId>',
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trim().split(/\s+/).filter(Boolean);
      if (parts.length <= 1 && !prefix.endsWith(' ')) {
        return ['list', 'read']
          .filter((item) => item.startsWith(parts[0] ?? ''))
          .map((item) => ({ value: item, label: item }));
      }
      return discoverRuns()
        .slice(0, 20)
        .map((run) => ({ value: runUri(run.record), label: runUri(run.record) }));
    },
    handler: async (args, ctx) => {
      const [sub = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (['list', 'ls'].includes(sub)) {
        postCommandResult(pi, ctx, formatRunList(discoverRuns(), rest.join(' ') || undefined, DEFAULT_LIMIT));
        return;
      }
      if (['read', 'show', 'cat'].includes(sub)) {
        const uri = rest[0];
        if (!uri) {
          ctx.ui.notify('Usage: /agent read agent://<namespace>/<runId>', 'warning');
          return;
        }
        try {
          postCommandResult(pi, ctx, readAgentUri(uri, DEFAULT_MAX_LINES));
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
        return;
      }
      ctx.ui.notify('Usage: /agent list [query] | /agent read agent://<namespace>/<runId>', 'warning');
    },
  });
}
