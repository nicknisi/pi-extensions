/**
 * codemode for the first-party subagent platform.
 *
 * One tool, `codemode`: the model writes TypeScript that orchestrates
 * subagents compositionally (Promise.all fan-out, pipelines, map/reduce),
 * and the tool compiles + runs it in-process via bundle-require, returning
 * the module's default export as the result.
 *
 * The snippet executes IN the host process with full Node access —
 * process/require/fs are all reachable. Its codemode API is three injected
 * bindings:
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
import type { ExtensionAPI, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getKeybindings, Text } from '@earendil-works/pi-tui';
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

/** Spawn options as exposed to the codemode snippet: the shared runtime's set, plus `text` — an explicit raw-text opt-in. */
type CodemodeSpawnOptions = SpawnOptions & { text?: boolean };

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

// ── TUI rendering ────────────────────────────────────────────────────────
// Presentation only — the tool's text content stays authoritative for the
// model. Visual vocabulary matches llm-council: ✓/✗ prefixes, └─ branch
// lines, indented sub-lines, dim metadata, one accent color (the label).

interface CodemodeDetails {
  label: string;
  logs: string[];
  durationMs: number;
  error?: string;
  stack?: string;
}

const SPINNER_CHARS = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()];
const SPINNER_INTERVAL_MS = 80;
const BRANCH_PREFIX = '└─';
const INDENT = '   '; // visible width of '└─' + 1
const RESULT_PREVIEW_LINES = 10;
const CODE_PREVIEW_MAX = 60;

function fg(theme: Theme, color: ThemeColor, text: string): string {
  try {
    return theme.fg(color, text);
  } catch {
    return text;
  }
}

function makeText(lastComponent: unknown, text: string): Text {
  const comp = lastComponent instanceof Text ? lastComponent : new Text('', 0, 0);
  comp.setText(text);
  return comp;
}

function branchLine(theme: Theme, text: string): string {
  return `${fg(theme, 'muted', BRANCH_PREFIX)} ${text}`;
}

function indentLine(text: string): string {
  return `${INDENT}${text}`;
}

function expandHint(theme: Theme): string {
  const key = getKeybindings().getKeys('app.tools.expand')[0] ?? 'ctrl+o';
  return fg(theme, 'dim', ` • ${key} to expand`);
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `(${Math.round(ms)}ms)`;
  if (ms < 60_000) return `(${(ms / 1000).toFixed(1)}s)`;
  return `(${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s)`;
}

/** First meaningful (non-blank) code line, trimmed and capped, plus total lines. */
function codePreview(code: string | undefined): { line: string; count: number } {
  if (!code) return { line: '...', count: 0 };
  const lines = code.split('\n');
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? '...';
  return {
    line: first.length > CODE_PREVIEW_MAX ? `${first.slice(0, CODE_PREVIEW_MAX)}…` : first,
    count: lines.length,
  };
}

function appendLogTree(lines: string[], logs: string[], theme: Theme): void {
  if (logs.length === 0) return;
  lines.push('');
  lines.push(branchLine(theme, `${fg(theme, 'muted', 'logs')} ${fg(theme, 'dim', `(${logs.length})`)}`));
  for (const entry of logs) {
    for (const line of entry.split('\n')) lines.push(indentLine(fg(theme, 'dim', line)));
  }
}

function ensureSpinner(ctx: any): number {
  if (ctx?.state?.spinnerInterval) return ctx.state.spinnerFrame ?? 0;
  if (!ctx?.state) ctx.state = {};
  ctx.state.spinnerFrame = 0;
  ctx.state.spinnerInterval = setInterval(() => {
    ctx.state.spinnerFrame = (ctx.state.spinnerFrame + 1) % SPINNER_FRAMES.length;
    ctx.invalidate?.();
  }, SPINNER_INTERVAL_MS);
  return 0;
}

function clearSpinner(ctx: any) {
  if (ctx?.state?.spinnerInterval) {
    clearInterval(ctx.state.spinnerInterval);
    ctx.state.spinnerInterval = undefined;
  }
}

function spinnerDot(theme: Theme, frame: number): string {
  return `${fg(theme, 'muted', SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)} `;
}

export default function codemode(pi: ExtensionAPI) {
  const runtime = createSubagentRuntime({ namespace: 'codemode', artifactsDir: ARTIFACTS_ROOT });
  // Snippet bindings are handed over via a single global (globalThis.__piCodemode),
  // so two concurrent executions would clobber each other's spawn/log/runWorkflow —
  // serialize runs with a promise-chain mutex.
  let execChain: Promise<unknown> = Promise.resolve();

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
      "string label; model?: string 'provider/id'; tools?: string[] allowlist (undefined = read-only",
      '[read, grep, find, ls]; pass [read, bash, edit, write] explicitly for builders); systemPrompt?:',
      'string; replaceSystemPrompt?: boolean; extensionPaths?: string[]; skillPaths?: string[];',
      'includeContextFiles?: boolean; outputSchema?: TypeBox-like JSON schema object (validated;',
      'parsed JSON lands in result.data; a schema-validating spawn that fails validation after one',
      "bounded repair attempt returns ok:false kind:'schema_invalid' — never a silently-empty string);",
      'text?: boolean (opt into raw text mode; REQUIRED when outputSchema is omitted — a spawn with',
      'neither outputSchema nor text:true is rejected immediately); cwd?: string; timeoutMs?: number',
      '(default 15 min);',
      'maxTurns?: number; maxToolCalls?: number; thinkingLevel?: string }. Composition — Promise.all',
      'Composition — Promise.all',
      'fan-out, sequential pipelines, map/reduce over files — is your code. For dependent multi-stage',
      'work use runWorkflow(spec, opts?): { name, stages: [{ id, prompt (string or (ctx, item?, index?)',
      '=> string; ctx = { results, treeDiffs, cwd, runDir }), needs?: string[] (default: previous stage),',
      'model?, tools?, systemPrompt?, outputSchema?, foreach?: unknown[] | { from: stageId, pick?: (outcome)',
      '=> unknown[] }, gate?: (outcome, ctx) => true | { revise: feedback }, maxGateAttempts?, retries?,',
      'sharesTree?: boolean (never overlaps other stages; its git diff HEAD flows to dependents via',
      'treeDiffs), maxTurns?, maxToolCalls?, timeoutMs? }], concurrency?, tokenBudget? } — resolves to',
      '{ ok, outcomes, usage, runDir }; never rejects. The snippet runs IN the host process with full',
      'Node access (process/require/fs reachable) — the same trust boundary as the bash tool. Keep the',
      'default export SMALL (summaries, counts, key findings) — never raw file dumps.',
    ].join(' '),
    promptSnippet: 'Run TypeScript that orchestrates subagents compositionally',
    promptGuidelines: [
      'ALWAYS `export default` a small summary — counts, key findings, short lists — never raw file contents.',
      'spawn never rejects: check result.ok and read result.error/result.kind on failure instead of try/catch around spawn.',
      'Fan out independent work with Promise.all([...]) and pass read-only tool allowlists (read, grep, find, ls) to research children.',
      'Wrap risky non-spawn steps (parsing, arithmetic on untrusted shapes) in try/catch — a thrown error fails the whole run.',
      'Every spawn() must declare its output contract: pass outputSchema for structured data (validated; lands in result.data) or text:true for raw text. A spawn with NEITHER throws immediately — it does not return unparsed text.',
      'Prefer runWorkflow over hand-rolled Promise.all when stages depend on each other, need gates/retries, or edit the working tree.',
      'Use log(...) for progress notes; they come back in the result details.',
      'Do not attempt imports — the snippet is bundled standalone and only spawn/runWorkflow/log are available.',
      'Never write busy-wait or long synchronous loops — they block the host event loop and can freeze the session (the timeout cannot preempt synchronous JS).',
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

      const spawn = (options: CodemodeSpawnOptions): Promise<SpawnResult> => {
        // Output contract: a schema-less spawn returns raw text, and reading a
        // field off unparsed text fails silently (undefined, not an error) — a
        // whole fan-out can look successful while every result is unusable.
        // Require EITHER an outputSchema OR an explicit `text: true` opt-in.
        // This throws synchronously and loudly rather than returning ok:false,
        // so the run cannot be mistaken for a success.
        if (!options.outputSchema && !options.text) {
          throw new Error(
            'spawn() requires an explicit output contract: pass `outputSchema` ' +
              'for validated structured output (parsed JSON lands in result.data) ' +
              'or `text: true` to opt into raw text mode. A schema-less spawn ' +
              'without `text: true` is rejected to prevent silently-unusable ' +
              'results (reading a field off unparsed text yields undefined, not an error).',
          );
        }
        const merged = mergeSignals(options.signal, signal ?? undefined, controller.signal);
        const { signal: _userSignal, text: _text, ...rest } = options;
        const opts: SpawnOptions = { ...rest, cwd: options.cwd ?? ctx.cwd };
        // Default children to read-only, matching dispatch; pi's own default
        // (read/bash/edit/write) would apply otherwise.
        if (opts.tools === undefined) opts.tools = ['read', 'grep', 'find', 'ls'];
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

      // Serialize executions: the snippet reads its bindings from the single
      // global set below, so two concurrent runs would clobber each other's
      // spawn/log/runWorkflow. Wait for the previous run's finally to release.
      const previous = execChain;
      let release!: () => void;
      execChain = new Promise<void>((resolve) => (release = resolve));
      await previous;

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
            ...(err instanceof Error && err.stack ? { stack: truncate(err.stack, MAX_STACK_CHARS) } : {}),
          },
        };
      } finally {
        if (timer) clearTimeout(timer);
        delete (globalThis as any)[GLOBAL_KEY];
        fs.rmSync(dir, { recursive: true, force: true });
        release(); // let the next queued run set its own bindings
      }
    },

    renderCall(args, theme, ctx) {
      const label = args.label?.trim() || 'codemode';
      const preview = codePreview(args.code);
      const header = `${fg(theme, 'toolTitle', theme.bold('Codemode'))} ${fg(theme, 'accent', label)}`;
      const meta = fg(theme, 'dim', `${preview.line} · ${preview.count} ${preview.count === 1 ? 'line' : 'lines'}`);
      const body = `${header}\n${branchLine(theme, meta)}`;

      if (!ctx?.isPartial) {
        clearSpinner(ctx);
        return makeText(ctx?.lastComponent, `${fg(theme, 'success', '✓')} ${body}`);
      }
      return makeText(ctx.lastComponent, `${spinnerDot(theme, ensureSpinner(ctx))}${body}`);
    },

    renderResult(result, options, theme, ctx) {
      const details = result.details as CodemodeDetails | undefined;
      const expanded = options?.expanded ?? false;
      const content = result.content[0];
      const fullText = content?.type === 'text' ? content.text : '';

      // No details — plain text fallback
      if (!details) {
        return makeText(ctx?.lastComponent, fullText || '(no output)');
      }

      const logs = details.logs ?? [];
      const label = fg(theme, 'accent', details.label);
      const duration = fg(theme, 'dim', formatDuration(details.durationMs));

      // ── Error state ──────────────────────────────────────────────
      if (details.error) {
        const header = `${fg(theme, 'error', '✗')} ${label} ${duration}`;
        const firstLine = details.error.split('\n')[0] ?? details.error;
        if (!expanded) {
          const lines = [header, `${branchLine(theme, fg(theme, 'error', firstLine))}${expandHint(theme)}`];
          return makeText(ctx?.lastComponent, lines.join('\n'));
        }
        const lines = [header, branchLine(theme, fg(theme, 'error', firstLine))];
        if (details.stack) {
          for (const line of details.stack.split('\n')) lines.push(indentLine(fg(theme, 'dim', line)));
        }
        appendLogTree(lines, logs, theme);
        return makeText(ctx?.lastComponent, lines.join('\n'));
      }

      // ── Success ──────────────────────────────────────────────────
      const header = `${fg(theme, 'success', '✓')} ${label} ${duration}`;
      const resultLines = fullText.split('\n');

      // Collapsed: first ~10 lines + dim overflow marker
      if (!expanded) {
        const shown = resultLines.slice(0, RESULT_PREVIEW_LINES);
        const remaining = resultLines.length - shown.length;
        const lines = [header];
        shown.forEach((line, i) => lines.push(i === 0 ? branchLine(theme, line) : indentLine(line)));
        if (remaining > 0) {
          lines.push(`${indentLine(fg(theme, 'dim', `+${remaining} more lines`))}${expandHint(theme)}`);
        } else if (logs.length > 0) {
          lines[0] = `${header}${expandHint(theme)}`;
        }
        return makeText(ctx?.lastComponent, lines.join('\n'));
      }

      // Expanded: full result + captured logs as an indented tree section
      const lines = [header];
      resultLines.forEach((line, i) => lines.push(i === 0 ? branchLine(theme, line) : indentLine(line)));
      appendLogTree(lines, logs, theme);
      return makeText(ctx?.lastComponent, lines.join('\n'));
    },
  });
}
