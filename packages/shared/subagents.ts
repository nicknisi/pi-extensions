/**
 * In-process subagent runtime for pi extensions.
 *
 * Spawns focused child agent sessions through pi's SDK (`createAgentSession`)
 * — no subprocesses, no dependency on pi-subagents. Because pi's extension
 * loader aliases `@earendil-works/*` imports to the running host, children are
 * always version-matched to the pi that loaded the extension.
 *
 * Design rules baked in:
 * - Hermetic by default: no user extensions, skills, prompt templates, themes,
 *   or context files load into a child unless explicitly requested via
 *   `extensionPaths` / `skillPaths` / `includeContextFiles`.
 * - Tool scoping is by construction: a child gets exactly the allowlisted
 *   built-in tools plus the closure supervisor tool (when requested). A child
 *   cannot spawn children of its own — no spawn capability exists as a tool.
 * - `spawn()` never rejects. Failures are typed:
 *   'crashed' | 'empty' | 'schema_invalid' | 'aborted'.
 * - The ecosystem recursion guard is honored, not namespaced: when
 *   PI_SUBAGENT_DEPTH / PI_SUBAGENT_CHILD are present (we are inside a
 *   pi-subagents child), spawning is refused.
 *
 * Proven by spike before implementation: hermetic loader, tool allowlists,
 * closure supervisor round-trip, streaming, ~2ms abort, and model/auth
 * inheritance all verified against pi 0.84.1.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

// ── Public types ───────────────────────────────────────────────────────────

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface SupervisorRequest {
  message: string;
  reason?: string | undefined;
}

export type SupervisorHandler = (request: SupervisorRequest) => string | Promise<string>;

export interface SpawnOptions {
  /** The task prompt sent to the child. */
  prompt: string;
  /** Registry label (e.g. 'reviewer', 'member-A'). Purely informational. */
  agent?: string;
  /**
   * Model spec ('provider/id', optionally with a ':thinking' suffix) resolved
   * against the user's configured models/auth. Omit to use pi's default
   * resolution (session settings, else first available).
   */
  model?: string;
  /** Appended to pi's default system prompt (like --append-system-prompt). */
  systemPrompt?: string;
  /** Replace pi's default system prompt entirely instead of appending. */
  replaceSystemPrompt?: boolean;
  /**
   * Built-in tool allowlist. undefined = pi defaults (read, bash, edit,
   * write); [] = no tools; [...] = exactly those. The supervisor tool (when
   * `onSupervisorRequest` is set) is always added automatically.
   */
  tools?: string[];
  /** Thinking level: off | minimal | low | medium | high | xhigh | max. */
  thinkingLevel?: string;
  /** Explicit extension file paths to load into the child (hermetic otherwise). */
  extensionPaths?: string[];
  /** Explicit SKILL.md paths to load into the child (hermetic otherwise). */
  skillPaths?: string[];
  /** Load AGENTS.md / project context files. Default false. */
  includeContextFiles?: boolean;
  /**
   * TypeBox schema for the child's final message. The final text is parsed
   * as JSON (fences stripped) and validated; failures produce
   * kind: 'schema_invalid' — distinct from a schema-valid answer that
   * merely reports failure inside its fields.
   */
  outputSchema?: TSchema;
  /**
   * Parent-side supervisor channel. When set, the child gets a
   * `<namespace>_contact_supervisor` tool whose calls invoke this handler
   * and return its string as the tool result. In-process closure — no
   * filesystem, no polling.
   */
  onSupervisorRequest?: SupervisorHandler;
  /** Working directory for the child's tools. Default: process.cwd(). */
  cwd?: string;
  /** Wall-clock limit. Default 15 minutes; pass 0 to disable. */
  timeoutMs?: number;
  /** Aborts the child session (session.abort()) when fired. */
  signal?: AbortSignal;
  /** Abort after this many agent turns (budget exceeded → kind 'aborted'). */
  maxTurns?: number;
  /** Abort after this many tool executions (budget exceeded → kind 'aborted'). */
  maxToolCalls?: number;
}

export interface SpawnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number | undefined;
}

export type SpawnFailureKind = 'crashed' | 'empty' | 'schema_invalid' | 'aborted';

export type SpawnFailure = {
  ok: false;
  runId: string;
  kind: SpawnFailureKind;
  error: string;
  text: string;
  usage: SpawnUsage;
  durationMs: number;
};

export type SpawnResult =
  | { ok: true; runId: string; text: string; data?: unknown; usage: SpawnUsage; durationMs: number }
  | SpawnFailure;

export interface RunRecord {
  runId: string;
  namespace: string;
  agent?: string | undefined;
  model?: string | undefined;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted';
  promptPreview: string;
  startedAt: number;
  endedAt?: number | undefined;
  usage?: SpawnUsage | undefined;
  error?: string | undefined;
}

export interface SubagentRuntime {
  readonly namespace: string;
  spawn(options: SpawnOptions): Promise<SpawnResult>;
  /** Launch without awaiting; track via listRuns()/artifacts or the returned promise. */
  spawnDetached(options: SpawnOptions): { runId: string; done: Promise<SpawnResult> };
  /** Snapshot of recent runs, newest first. */
  listRuns(): RunRecord[];
  /** Currently executing (not queued) spawns. */
  activeCount(): number;
}

// ── Internals ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RETAINED_RUNS = 200;
const MAX_ARTIFACT_OUTPUT_CHARS = 64 * 1024;
const MAX_ARTIFACT_FILES_READ = 500;

function fail(runId: string, kind: SpawnFailureKind, error: string, startedAt: number): SpawnFailure {
  return {
    ok: false,
    runId,
    kind,
    error,
    text: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    durationMs: Date.now() - startedAt,
  };
}

/** Mark a run record failed from an early (pre-spawn) failure result. */
function markFailed(record: RunRecord, result: SpawnFailure): SpawnFailure {
  record.status = 'failed';
  record.endedAt = Date.now();
  record.error = result.error;
  return result;
}

/**
 * The child session's terminal error, if its last turn failed or was aborted.
 * Typed through AgentSession so an SDK rename breaks the build, not silently.
 */
function childSessionError(session: AgentSession): string | undefined {
  return session.agent.state.errorMessage;
}

/** Extract the text of the last assistant message that produced any. */
function lastAssistantText(messages: readonly any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

function sumUsage(messages: readonly any[]): SpawnUsage {
  const usage: SpawnUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let cost = 0;
  let hasCost = false;
  for (const m of messages) {
    if (m?.role !== 'assistant' || !m.usage) continue;
    usage.inputTokens += m.usage.input ?? 0;
    usage.outputTokens += m.usage.output ?? 0;
    usage.totalTokens += m.usage.totalTokens ?? 0;
    if (typeof m.usage.cost?.total === 'number') {
      cost += m.usage.cost.total;
      hasCost = true;
    }
  }
  if (hasCost) usage.cost = cost;
  return usage;
}

/** Parse JSON out of a final message: fenced block, whole body, or outermost {...}/[...] slice. */
function extractJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(text.trim());
  const start = text.search(/[{[]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // try next candidate
    }
  }
  return { ok: false };
}

function validateOutput(schema: TSchema, raw: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  if (Value.Check(schema, raw)) return { ok: true, data: raw };
  // One normalization pass: drop unknown properties, coerce convertible
  // scalars, then re-check. Keeps 'additionalProperties: false' schemas
  // tolerant of chatty models without engine-side string surgery.
  try {
    const normalized = Value.Convert(schema, Value.Clean(schema, structuredClone(raw)));
    if (Value.Check(schema, normalized)) return { ok: true, data: normalized };
  } catch {
    // fall through to error reporting
  }
  const errors = [...Value.Errors(schema, raw)]
    .slice(0, 3)
    .map((e) => `${e.instancePath || '/'}: ${e.message}`)
    .join('; ');
  return { ok: false, error: errors || 'output did not match schema' };
}

/**
 * Resolve a bare resource name under the agent dir to a contained absolute
 * path, or null if the name could escape. Untrusted config (e.g. project-local
 * config files) must never smuggle path separators or '..' into a path handed
 * to a child's loader.
 */
export function resolveContainedAgentResource(
  kind: 'extensions' | 'skills',
  name: string,
  leaf: string,
): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') return null;
  const baseDir = path.join(getAgentDir(), kind);
  const resolved = path.resolve(baseDir, name, leaf);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) return null;
  return resolved;
}

/** A RunRecord persisted to disk, optionally carrying the run's output text. */
export interface RunArtifact extends RunRecord {
  output?: string | undefined;
}

/**
 * Read persisted run artifacts from a shared root ("<root>/<namespace>/<runId>.json").
 * Cross-extension by design: every runtime persisting to the same root is
 * visible here, which is what a fleet view needs given pi's per-extension
 * module isolation. Defensive against partial/garbage files.
 */
export function readRunArtifacts(rootDir: string): RunArtifact[] {
  const out: RunArtifact[] = [];
  let namespaces: fs.Dirent[];
  try {
    namespaces = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  let read = 0;
  for (const ns of namespaces) {
    if (!ns.isDirectory()) continue;
    const dir = path.join(rootDir, ns.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (read >= MAX_ARTIFACT_FILES_READ) return out;
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      read++;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file.name), 'utf8'));
        if (parsed && typeof parsed.runId === 'string' && typeof parsed.status === 'string') {
          out.push(parsed as RunArtifact);
        }
      } catch {
        // skip unreadable artifact
      }
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// ── Runtime ────────────────────────────────────────────────────────────────

export function createSubagentRuntime(options: {
  namespace: string;
  maxConcurrent?: number;
  /** When set, run records (plus bounded output) persist to "<dir>/<namespace>/<runId>.json". */
  artifactsDir?: string;
}): SubagentRuntime {
  const namespace = options.namespace;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const artifactsDir = options.artifactsDir;
  const toolNamespace = namespace.replace(/[^a-zA-Z0-9]/g, '_');

  const runs: RunRecord[] = [];
  let active = 0;
  const waiters: Array<() => void> = [];
  let modelRuntimePromise: Promise<ModelRuntime> | undefined;

  function modelRuntime(): Promise<ModelRuntime> {
    modelRuntimePromise ??= ModelRuntime.create();
    return modelRuntimePromise;
  }

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  }

  function release(): void {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  }

  function persist(record: RunRecord, output?: string): void {
    if (!artifactsDir) return;
    try {
      const dir = path.join(artifactsDir, namespace);
      fs.mkdirSync(dir, { recursive: true });
      const artifact: RunArtifact = { ...record };
      if (output !== undefined) artifact.output = output.slice(0, MAX_ARTIFACT_OUTPUT_CHARS);
      const file = path.join(dir, `${record.runId}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2));
      fs.renameSync(tmp, file);
    } catch {
      // artifact persistence is best-effort; never fail a run over it
    }
  }

  function recordRun(record: RunRecord): void {
    runs.unshift(record);
    if (runs.length > MAX_RETAINED_RUNS) runs.length = MAX_RETAINED_RUNS;
    persist(record);
  }

  function spawn(opts: SpawnOptions): Promise<SpawnResult> {
    return spawnDetached(opts).done;
  }

  function spawnDetached(opts: SpawnOptions): { runId: string; done: Promise<SpawnResult> } {
    const runId = randomUUID();
    return { runId, done: spawnChild(runId, opts) };
  }

  async function spawnChild(runId: string, opts: SpawnOptions): Promise<SpawnResult> {
    const startedAt = Date.now();
    const record: RunRecord = {
      runId,
      namespace,
      status: 'queued',
      promptPreview: opts.prompt.replace(/\s+/g, ' ').trim().slice(0, 80),
      startedAt,
    };
    if (opts.agent) record.agent = opts.agent;
    if (opts.model) record.model = opts.model;
    recordRun(record);

    // Ecosystem recursion guard — honored, not namespaced. See header.
    if (process.env.PI_SUBAGENT_DEPTH || process.env.PI_SUBAGENT_CHILD) {
      return markFailed(
        record,
        fail(
          runId,
          'crashed',
          'Refusing to spawn: PI_SUBAGENT_DEPTH/PI_SUBAGENT_CHILD present (nested orchestration is an ecosystem-level guard).',
          startedAt,
        ),
      );
    }

    if (
      opts.thinkingLevel !== undefined &&
      !THINKING_LEVELS.includes(opts.thinkingLevel as (typeof THINKING_LEVELS)[number])
    ) {
      return markFailed(
        record,
        fail(
          runId,
          'crashed',
          `Invalid thinkingLevel ${JSON.stringify(opts.thinkingLevel)}; expected one of ${THINKING_LEVELS.join(', ')}.`,
          startedAt,
        ),
      );
    }

    await acquire();
    record.status = 'running';
    persist(record);
    try {
      return await runChild(runId, opts, startedAt, record);
    } finally {
      release();
    }
  }

  async function runChild(
    runId: string,
    opts: SpawnOptions,
    startedAt: number,
    record: RunRecord,
  ): Promise<SpawnResult> {
    const cwd = opts.cwd ?? process.cwd();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Supervisor channel: a closure tool, not a protocol.
    const customTools = [];
    let supervisorToolName: string | undefined;
    if (opts.onSupervisorRequest) {
      const handler = opts.onSupervisorRequest;
      supervisorToolName = `${toolNamespace}_contact_supervisor`;
      customTools.push(
        defineTool({
          name: supervisorToolName,
          label: 'Contact Supervisor',
          description:
            'Contact the parent/supervisor session for a decision, clarification, or progress update. The reply arrives as the tool result.',
          parameters: Type.Object({
            message: Type.String({ description: 'What you need from the supervisor' }),
            reason: Type.Optional(Type.String({ description: 'e.g. need_decision, progress_update' })),
          }),
          execute: async (_id, params) => {
            const request: SupervisorRequest = { message: params.message };
            if (params.reason !== undefined) request.reason = params.reason;
            const reply = await handler(request);
            return { content: [{ type: 'text' as const, text: String(reply) }], details: {} };
          },
        }),
      );
    }

    // Tool allowlist: undefined → pi defaults; array → exactly those (+ supervisor tool).
    let tools: string[] | undefined;
    if (opts.tools !== undefined) {
      tools = [...opts.tools];
      if (supervisorToolName && !tools.includes(supervisorToolName)) tools.push(supervisorToolName);
    }

    const runtime = await modelRuntime();

    let model: ReturnType<typeof resolveCliModel>['model'];
    let thinkingLevel = opts.thinkingLevel;
    if (opts.model !== undefined) {
      const resolved = resolveCliModel({ cliModel: opts.model, modelRuntime: runtime });
      if (resolved.error || !resolved.model) {
        return markFailed(record, fail(runId, 'crashed', resolved.error ?? `Unknown model: ${opts.model}`, startedAt));
      }
      model = resolved.model;
      thinkingLevel ??= resolved.thinkingLevel;
    }

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: !opts.includeContextFiles,
      additionalExtensionPaths: opts.extensionPaths ?? [],
      additionalSkillPaths: opts.skillPaths ?? [],
      ...(opts.systemPrompt !== undefined
        ? opts.replaceSystemPrompt
          ? { systemPrompt: opts.systemPrompt }
          : { appendSystemPrompt: [opts.systemPrompt] }
        : {}),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      modelRuntime: runtime,
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel: thinkingLevel as never } : {}),
      ...(tools !== undefined ? { tools } : {}),
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
    });

    let abortReason: string | undefined;
    const abortOnce = (reason: string) => {
      if (abortReason !== undefined) return;
      abortReason = reason;
      void session.abort();
    };
    const onSignalAbort = () => abortOnce('Aborted by caller');
    if (opts.signal) {
      if (opts.signal.aborted) onSignalAbort();
      else opts.signal.addEventListener('abort', onSignalAbort, { once: true });
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            abortOnce(`Timed out after ${timeoutMs}ms`);
          }, timeoutMs)
        : undefined;

    let turnCount = 0;
    let toolCallCount = 0;
    if (opts.maxTurns !== undefined || opts.maxToolCalls !== undefined) {
      session.subscribe((event: AgentSessionEvent) => {
        // Typed narrowing: a pi event rename fails the build here instead of
        // silently disabling budget enforcement.
        switch (event.type) {
          case 'turn_start': {
            turnCount++;
            if (opts.maxTurns !== undefined && turnCount > opts.maxTurns) {
              abortOnce(`Turn budget exceeded (${opts.maxTurns})`);
            }
            break;
          }
          case 'tool_execution_start': {
            toolCallCount++;
            if (opts.maxToolCalls !== undefined && toolCallCount > opts.maxToolCalls) {
              abortOnce(`Tool-call budget exceeded (${opts.maxToolCalls})`);
            }
            break;
          }
        }
      });
    }

    let promptError: unknown;
    try {
      await session.prompt(opts.prompt);
    } catch (err) {
      promptError = err;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onSignalAbort);
    }

    const messages = session.messages as readonly any[];
    const text = lastAssistantText(messages);
    const usage = sumUsage(messages);
    const stateError = childSessionError(session);
    session.dispose();

    const durationMs = Date.now() - startedAt;
    record.endedAt = Date.now();
    record.usage = usage;

    const finish = (result: SpawnResult): SpawnResult => {
      if (result.ok) {
        record.status = 'completed';
      } else {
        record.status = result.kind === 'aborted' ? 'aborted' : 'failed';
        record.error = result.error;
      }
      persist(record, result.text);
      return result;
    };

    if (abortReason !== undefined) {
      return finish({
        ok: false,
        runId,
        kind: 'aborted',
        error: abortReason,
        text,
        usage,
        durationMs,
      });
    }
    if (promptError) {
      return finish({
        ok: false,
        runId,
        kind: 'crashed',
        error: promptError instanceof Error ? promptError.message : String(promptError),
        text,
        usage,
        durationMs,
      });
    }
    if (!text) {
      return finish({
        ok: false,
        runId,
        kind: 'empty',
        error: stateError ? `Child produced no output (session error: ${stateError})` : 'Child produced no output',
        text: '',
        usage,
        durationMs,
      });
    }
    if (opts.outputSchema) {
      const parsed = extractJson(text);
      if (!parsed.ok) {
        return finish({
          ok: false,
          runId,
          kind: 'schema_invalid',
          error: 'Final message did not contain parseable JSON',
          text,
          usage,
          durationMs,
        });
      }
      const validated = validateOutput(opts.outputSchema, parsed.value);
      if (!validated.ok) {
        return finish({ ok: false, runId, kind: 'schema_invalid', error: validated.error, text, usage, durationMs });
      }
      return finish({ ok: true, runId, text, data: validated.data, usage, durationMs });
    }
    return finish({ ok: true, runId, text, usage, durationMs });
  }

  return {
    namespace,
    spawn,
    spawnDetached,
    listRuns: () => runs.map((r) => ({ ...r })),
    activeCount: () => active,
  };
}
