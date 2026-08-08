/**
 * codemode for the first-party subagent platform.
 *
 * One tool, `codemode`: the model writes TypeScript that orchestrates
 * subagents compositionally (Promise.all fan-out, pipelines, map/reduce),
 * and the tool compiles + runs it in-process via bundle-require, returning
 * the module's default export as the result.
 *
 * The snippet runs standalone — no imports resolve from the temp dir. Its
 * entire API is three injected bindings:
 *
 *   spawn(options: SpawnOptions): Promise<SpawnResult>  — shared-runtime
 *     spawn (namespace 'codemode'); never rejects, check result.ok.
 *   runWorkflow(spec: WorkflowSpec, opts?): Promise<WorkflowResult> —
 *     declarative multi-stage DAGs over spawn (needs/foreach/gates/retries,
 *     sharesTree tree-diff handoff, control artifacts); never rejects.
 *   log(...args): void — captured into the tool result's details.
 *
 * Safety posture: this executes model-written code with the host process's
 * full privileges. That is the accepted model (your model, your session) —
 * the same trust boundary as pi-codemode and any bash tool call.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  createSubagentRuntime,
  runWorkflow,
  type RunWorkflowOptions,
  type SpawnOptions,
  type SpawnResult,
  type WorkflowResult,
  type WorkflowSpec,
} from '@nicknisi/pi-shared';
import { bundleRequire } from 'bundle-require';
import { Type } from 'typebox';

const ARTIFACTS_ROOT = path.join(getAgentDir(), 'subagent-runs');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RESULT_CHARS = 16 * 1024;
const MAX_STACK_CHARS = 4000;
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_CHARS = 2000;

const BINDINGS_PRELUDE = 'const { spawn, log, runWorkflow } = (globalThis as any).__piCodemode;\n';
const GLOBAL_KEY = '__piCodemode';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated at ${max} chars]`;
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const controller = new AbortController();
  const fire = () => controller.abort();
  for (const s of present) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', fire, { once: true });
  }
  return controller.signal;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.message}${err.stack ? `\n\n${truncate(err.stack, MAX_STACK_CHARS)}` : ''}`;
  return String(err);
}

export default function codemode(pi: ExtensionAPI) {
  const runtime = createSubagentRuntime({ namespace: 'codemode', artifactsDir: ARTIFACTS_ROOT });

  pi.registerTool({
    name: 'codemode',
    label: 'Codemode',
    description: [
      'Execute a TypeScript snippet that orchestrates subagents compositionally and returns a result.',
      'The snippet runs in-process with two injected bindings — spawn(options) and log(...args) — and',
      'MUST `export default` its result. spawn(options) launches a hermetic child agent session',
      '(in-process, no user extensions/skills/context) and resolves to a SpawnResult: on success',
      '{ ok: true, text, data?, usage, durationMs, runId }; on failure { ok: false, kind:',
      "'crashed'|'empty'|'schema_invalid'|'aborted', error, text, usage, durationMs, runId }.",
      'spawn never rejects — check result.ok. SpawnOptions: { prompt: string (required); agent?:',
      "string label; model?: string 'provider/id'; tools?: string[] allowlist (undefined = pi defaults",
      'read/bash/edit/write — pass [read, grep, find, ls] for read-only children); systemPrompt?:',
      'string; replaceSystemPrompt?: boolean; extensionPaths?: string[]; skillPaths?: string[];',
      'includeContextFiles?: boolean; outputSchema?: TypeBox-like JSON schema object (validated;',
      'parsed JSON lands in result.data); cwd?: string; timeoutMs?: number (default 15 min);',
      'maxTurns?: number; maxToolCalls?: number; thinkingLevel?: string }. Composition — Promise.all',
      'Composition — Promise.all',
      'fan-out, sequential pipelines, map/reduce over files — is your code. For dependent multi-stage',
      'work use runWorkflow(spec, opts?): { name, stages: [{ id, prompt (string or (ctx, item?, index?)',
      '=> string; ctx = { results, treeDiffs, cwd, runDir }), needs?: string[] (default: previous stage),',
      'model?, tools?, systemPrompt?, outputSchema?, foreach?: unknown[] | { from: stageId, pick?: (outcome)',
      '=> unknown[] }, gate?: (outcome, ctx) => true | { revise: feedback }, maxGateAttempts?, retries?,',
      'sharesTree?: boolean (never overlaps other stages; its git diff HEAD flows to dependents via',
      'treeDiffs), maxTurns?, maxToolCalls?, timeoutMs? }], concurrency?, tokenBudget? } — resolves to',
      '{ ok, outcomes, usage, runDir }; never rejects. No imports resolve;',
      'spawn, runWorkflow, and log are the whole API. Keep the default export SMALL (summaries, counts, key',
      'findings) — never raw file dumps.',
    ].join(' '),
    promptSnippet: 'Run TypeScript that orchestrates subagents compositionally',
    promptGuidelines: [
      'ALWAYS `export default` a small summary — counts, key findings, short lists — never raw file contents.',
      'spawn never rejects: check result.ok and read result.error/result.kind on failure instead of try/catch around spawn.',
      'Fan out independent work with Promise.all([...]) and pass read-only tool allowlists (read, grep, find, ls) to research children.',
      'Wrap risky non-spawn steps (parsing, arithmetic on untrusted shapes) in try/catch — a thrown error fails the whole run.',
      'Prefer runWorkflow over hand-rolled Promise.all when stages depend on each other, need gates/retries, or edit the working tree.',
      'Use log(...) for progress notes; they come back in the result details.',
      'Do not attempt imports — the snippet is bundled standalone and only spawn/runWorkflow/log are available.',
    ],
    parameters: Type.Object({
      code: Type.String({ description: 'TypeScript source. Must `export default` the result.' }),
      label: Type.Optional(Type.String({ description: 'Short label for this run (result heading).' })),
      timeoutMs: Type.Optional(Type.Number({ description: 'Wall-clock cap. Default 10 min, max 30 min.' })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const label = params.label ?? 'codemode';
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      const logs: string[] = [];
      const controller = new AbortController();

      const log = (...args: unknown[]) => {
        if (logs.length >= MAX_LOG_ENTRIES) return;
        const line = args
          .map((a) => {
            if (typeof a === 'string') return a;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(' ');
        logs.push(truncate(line, MAX_LOG_CHARS));
      };

      const spawn = (options: SpawnOptions): Promise<SpawnResult> => {
        const merged = mergeSignals(options.signal, signal ?? undefined, controller.signal);
        const { signal: _userSignal, ...rest } = options;
        const opts: SpawnOptions = { ...rest, cwd: options.cwd ?? ctx.cwd };
        if (merged) opts.signal = merged;
        return runtime.spawn(opts);
      };

      const boundRunWorkflow = (
        spec: WorkflowSpec,
        wfOpts: Partial<RunWorkflowOptions> = {},
      ): Promise<WorkflowResult> => {
        const merged = mergeSignals(wfOpts.signal, signal ?? undefined, controller.signal);
        const full: RunWorkflowOptions = { cwd: ctx.cwd, ...wfOpts };
        if (merged) full.signal = merged;
        return runWorkflow(spec, runtime, full);
      };

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-codemode-'));
      const file = path.join(dir, 'snippet.ts');
      fs.writeFileSync(file, BINDINGS_PRELUDE + params.code);
      const startedAt = Date.now();

      const runSnippet = async (): Promise<unknown> => {
        const { mod } = await bundleRequire({
          filepath: file,
          format: 'esm',
          esbuildOptions: { target: 'es2022' },
        });
        return mod.default;
      };

      (globalThis as any)[GLOBAL_KEY] = { spawn, log, runWorkflow: boundRunWorkflow };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const execPromise = runSnippet();
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(); // in-flight spawns abort; the JS itself can't be preempted
            reject(new Error(`Timed out after ${timeoutMs}ms (in-flight subagents were aborted)`));
          }, timeoutMs);
        });
        const value = await Promise.race([execPromise, timeoutPromise]);
        execPromise.catch(() => {}); // if we raced ahead, swallow any late rejection
        const text =
          typeof value === 'string'
            ? truncate(value, MAX_RESULT_CHARS)
            : value === undefined
              ? '(undefined — did you forget `export default`?)'
              : truncate(JSON.stringify(value, null, 2) ?? String(value), MAX_RESULT_CHARS);
        return {
          content: [{ type: 'text' as const, text }],
          details: { label, logs, durationMs: Date.now() - startedAt },
        };
      } catch (err) {
        const logText = logs.length > 0 ? `\n\nCaptured logs (${logs.length}):\n${logs.join('\n')}` : '';
        return {
          content: [{ type: 'text' as const, text: `${label} failed:\n\n${formatError(err)}${logText}` }],
          details: {
            label,
            logs,
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      } finally {
        if (timer) clearTimeout(timer);
        delete (globalThis as any)[GLOBAL_KEY];
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  });
}
