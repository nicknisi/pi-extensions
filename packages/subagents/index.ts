/**
 * First-party subagent dispatch + fleet for pi.
 *
 * `dispatch` — model-facing fan-out: run N focused child agents in parallel
 *   with per-task tool allowlists, models, and prompts; typed results
 *   aggregate back. Children are hermetic in-process sessions spawned through
 *   @nicknisi/pi-shared's runtime — no pi-subagents dependency, and children
 *   cannot themselves spawn.
 * `fleet` (tool) / `/fleet` (command) — inspect live and persisted runs,
 *   including background ones. Run records persist to
 *   <agentDir>/subagent-runs/<namespace>/<runId>.json, so runs from other
 *   extensions using the shared runtime show up here too.
 */

import * as path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { createSubagentRuntime, readRunArtifacts, type RunArtifact, type SpawnOptions } from '@nicknisi/pi-shared';
import { Type, type TSchema } from 'typebox';

const ARTIFACTS_ROOT = path.join(getAgentDir(), 'subagent-runs');
const MAX_TASKS = 8;
const DEFAULT_TOOLS = ['read', 'grep', 'find', 'ls'];
const TREE_MUTATING_TOOLS = new Set(['edit', 'write', 'bash']);
const MAX_TASK_OUTPUT_CHARS = 4000;
const MAX_FLEET_LIST = 20;

interface TaskSpec {
  task: string;
  agent?: string | undefined;
  model?: string | undefined;
  tools?: string[] | undefined;
  systemPrompt?: string | undefined;
  background?: boolean | undefined;
  allowTreeMutation?: boolean | undefined;
}

function wantsTreeMutation(spec: TaskSpec): boolean {
  return (spec.tools ?? []).some((tool) => TREE_MUTATING_TOOLS.has(tool));
}

function registerTool<TParams extends TSchema>(pi: ExtensionAPI, tool: ToolDefinition<TParams>): void {
  try {
    pi.registerTool(tool);
  } catch (err) {
    if (err instanceof Error && /already registered|duplicate|conflict/i.test(err.message)) {
      throw new Error(
        `@nicknisi/pi-subagents: another extension (likely nicobailon/pi-subagents) already registers the '${tool.name}' tool — uninstall it first (e.g. \`pi remove pi-subagents\`), then reload. Original error: ${err.message}`,
      );
    }
    throw err;
  }
}

function toSpawnOptions(spec: TaskSpec, cwd: string): SpawnOptions {
  const opts: SpawnOptions = {
    prompt: spec.task,
    tools: spec.tools ?? DEFAULT_TOOLS,
    cwd,
  };
  if (spec.agent) opts.agent = spec.agent;
  if (spec.model) opts.model = spec.model;
  if (spec.systemPrompt) opts.systemPrompt = spec.systemPrompt;
  return opts;
}

function short(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatTokens(usage: { totalTokens: number } | undefined): string {
  if (!usage) return '';
  const k = usage.totalTokens / 1000;
  return `, ${k >= 10 ? Math.round(k) : k.toFixed(1)}k tok`;
}

function formatSeconds(startedAt: number, endedAt?: number): string {
  const end = endedAt ?? Date.now();
  return `${((end - startedAt) / 1000).toFixed(1)}s`;
}

function formatRunLine(run: RunArtifact): string {
  const bits = [run.status, formatSeconds(run.startedAt, run.endedAt) + (run.endedAt ? '' : '…')];
  const tokens = formatTokens(run.usage);
  return `- ${run.runId.slice(0, 8)} [${run.namespace}]${run.agent ? ` ${run.agent}` : ''} — ${bits.join(', ')}${tokens} · ${short(run.promptPreview, 60)}`;
}

function collectFleet(live: RunArtifact[]): RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const record of readRunArtifacts(ARTIFACTS_ROOT)) byId.set(record.runId, record);
  for (const record of live) byId.set(record.runId, record); // live wins over disk
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

function postText(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string) {
  pi.sendMessage({
    customType: 'subagents:fleet',
    content: text,
    display: true,
    details: { kind: 'subagents-fleet' },
  });
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

export default function subagents(pi: ExtensionAPI) {
  const runtime = createSubagentRuntime({ namespace: 'subagents', artifactsDir: ARTIFACTS_ROOT });

  registerTool(pi, {
    name: 'dispatch',
    label: 'Dispatch Subagents',
    description: [
      'Fan out focused child agents in parallel: independent research questions, parallel reviews,',
      'second opinions, or scoped file investigations. Each child runs hermetically (no user',
      'extensions/skills/context files) with a read-only tool allowlist unless overridden, and',
      'returns its final answer. Children cannot spawn children. Not for trivial questions or',
      'sequential work — dispatch only when tasks are independent and parallel.',
      'Tasks whose tools include edit, write, or bash mutate the shared working tree: they require',
      'allowTreeMutation: true and always run sequentially, one at a time, after the parallel batch.',
    ].join(' '),
    promptSnippet: 'Fan out parallel child agents for independent subtasks',
    promptGuidelines: [
      `Use dispatch for independent parallel subtasks (max ${MAX_TASKS}); never for sequential work or trivial questions.`,
      'Children default to read-only tools (read, grep, find, ls). Pass tools explicitly for builders.',
      'Set background: true for long-running tasks; results surface via the fleet tool.',
      'Tasks with edit/write/bash tools need allowTreeMutation: true and serialize after the parallel batch — never dispatch two tree-mutating tasks expecting concurrency.',
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          task: Type.String({ description: 'The full prompt for this child agent' }),
          agent: Type.Optional(Type.String({ description: 'Label, e.g. "reviewer"' })),
          model: Type.Optional(Type.String({ description: 'Model spec, e.g. "anthropic/claude-haiku-4-5"' })),
          tools: Type.Optional(
            Type.Array(Type.String(), { description: 'Tool allowlist; default read-only (read, grep, find, ls)' }),
          ),
          systemPrompt: Type.Optional(Type.String({ description: 'Appended to the child system prompt' })),
          background: Type.Optional(Type.Boolean({ description: 'Run detached; check results via the fleet tool' })),
          allowTreeMutation: Type.Optional(
            Type.Boolean({
              description:
                'Required when tools include edit/write/bash; such tasks run sequentially after the parallel batch',
            }),
          ),
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const specs = params.tasks as TaskSpec[];
      if (specs.length === 0) {
        return toolResult('dispatch requires at least one task.');
      }
      if (specs.length > MAX_TASKS) {
        return toolResult(`Too many tasks (${specs.length}); max is ${MAX_TASKS}. Split into multiple dispatch calls.`);
      }

      const lines: string[] = [];

      // Refuse undeclared tree-mutating tasks outright; declared ones serialize after the parallel batch.
      const runnable: TaskSpec[] = [];
      const mutating: TaskSpec[] = [];
      for (const spec of specs) {
        if (wantsTreeMutation(spec)) {
          if (spec.allowTreeMutation === true) {
            mutating.push(spec);
          } else {
            lines.push(
              `## ✗ ${spec.agent ?? short(spec.task, 40)} — refused\n\nTools include edit/write/bash, which mutate the shared working tree. Resubmit with allowTreeMutation: true (the task will run sequentially, after the parallel batch).`,
            );
          }
        } else {
          runnable.push(spec);
        }
      }

      const background = runnable.filter((s) => s.background);
      const foreground = runnable.filter((s) => !s.background);

      for (const spec of background) {
        const { runId, done } = runtime.spawnDetached(toSpawnOptions(spec, ctx.cwd));
        lines.push(
          `⏳ ${spec.agent ?? short(spec.task, 40)} — background run ${runId.slice(0, 8)} (check the fleet tool)`,
        );
        // Deliberately no AbortSignal here: pi may abort tool signals after execute returns, which
        // would kill the background child. Swallow late failures — sendMessage throws once the
        // session is ending, and an unhandled rejection is worse than a lost notification.
        void done
          .then((result) => {
            pi.sendMessage({
              customType: 'subagents:background',
              content: `Background subagent ${runId.slice(0, 8)} (${spec.agent ?? 'task'}) ${result.ok ? 'completed' : `failed: ${result.error}`}`,
              display: true,
              details: { runId, ok: result.ok },
            });
          })
          .catch((err) => {
            console.error(`[subagents] background run ${runId.slice(0, 8)} completion notice failed:`, err);
          });
      }

      if (foreground.length > 0) {
        const results = await Promise.all(
          foreground.map((spec) =>
            runtime.spawn({
              ...toSpawnOptions(spec, ctx.cwd),
              ...(signal ? { signal } : {}),
            }),
          ),
        );
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          const spec = foreground[i]!;
          const label = spec.agent ?? short(spec.task, 40);
          if (result.ok) {
            lines.push(
              `## ✓ ${label} — ${formatSeconds(0, result.durationMs)}${formatTokens(result.usage)}\n\n${result.text.slice(0, MAX_TASK_OUTPUT_CHARS)}`,
            );
          } else {
            lines.push(
              `## ✗ ${label} — ${result.kind} (${formatSeconds(0, result.durationMs)})\n\n${result.error}${result.text ? `\n\nPartial output:\n${result.text.slice(0, 1000)}` : ''}`,
            );
          }
        }
      }

      // Tree-mutating tasks run strictly sequentially, after the parallel batch, so they never
      // stomp the working tree concurrently with each other or with read-only children.
      for (const spec of mutating) {
        const result = await runtime.spawn({
          ...toSpawnOptions(spec, ctx.cwd),
          ...(signal ? { signal } : {}),
        });
        const label = spec.agent ?? short(spec.task, 40);
        if (result.ok) {
          lines.push(
            `## ✓ ${label} — ${formatSeconds(0, result.durationMs)}${formatTokens(result.usage)}\n\n${result.text.slice(0, MAX_TASK_OUTPUT_CHARS)}`,
          );
        } else {
          lines.push(
            `## ✗ ${label} — ${result.kind} (${formatSeconds(0, result.durationMs)})\n\n${result.error}${result.text ? `\n\nPartial output:\n${result.text.slice(0, 1000)}` : ''}`,
          );
        }
      }

      return toolResult(lines.join('\n\n'));
    },
  });

  registerTool(pi, {
    name: 'fleet',
    label: 'Subagent Fleet',
    description:
      'Inspect subagent runs: list recent runs (live and persisted, across extensions using the shared runtime) or fetch a specific run result by runId. Use to check background dispatch results.',
    promptSnippet: 'List or inspect subagent runs',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('result')], {
        description: 'list runs or fetch one result',
      }),
      runId: Type.Optional(Type.String({ description: 'Run id (or unique prefix) for action=result' })),
    }),
    async execute(_toolCallId, params) {
      const live = runtime.listRuns() as RunArtifact[];
      const all = collectFleet(live);
      if (params.action === 'list') {
        if (all.length === 0) return toolResult('No subagent runs found.');
        const text = all.slice(0, MAX_FLEET_LIST).map(formatRunLine).join('\n');
        return toolResult(text, { runs: all.slice(0, MAX_FLEET_LIST) });
      }
      if (!params.runId) {
        return toolResult('action=result requires a runId (or prefix).');
      }
      const matches = all.filter((r) => r.runId.startsWith(params.runId!));
      if (matches.length === 0) return toolResult(`No run matches '${params.runId}'.`);
      if (matches.length > 1) {
        return toolResult(`Ambiguous runId prefix; matches: ${matches.map((m) => m.runId.slice(0, 8)).join(', ')}`);
      }
      const run = matches[0]!;
      const text = [
        formatRunLine(run),
        run.error ? `error: ${run.error}` : undefined,
        run.output
          ? `\n${run.output}`
          : run.status === 'running' || run.status === 'queued'
            ? '\n(still running — no output yet)'
            : '\n(no output recorded)',
      ]
        .filter(Boolean)
        .join('\n');
      return toolResult(text, { run });
    },
  });

  pi.registerCommand('fleet', {
    description: 'Show recent subagent runs (live + persisted, across extensions using the shared runtime)',
    handler: async (_args, ctx) => {
      const all = collectFleet(runtime.listRuns() as RunArtifact[]);
      postText(
        pi,
        ctx,
        all.length === 0 ? 'No subagent runs found.' : all.slice(0, MAX_FLEET_LIST).map(formatRunLine).join('\n'),
      );
    },
  });
}
