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
import { addWorktree, captureHandoff, findRepoRoot, removeWorktree } from './worktree.js';
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

/**
 * Parse the editor `&` dispatch prefix: `&<agent> <prompt>`. The first token is
 * the agent type only when a prompt follows it (`&scout` alone is the prompt
 * 'scout', not an agent). Returns null when there is no dispatchable prompt.
 */
export function parseAmpDispatch(text: string): { agentType?: string; prompt: string } | null {
  if (!text.startsWith('&')) return null;
  const rest = text.slice(1);
  const sp = rest.search(/\s/);
  let agentType: string | undefined;
  let prompt: string;
  if (sp === -1) {
    prompt = rest.trim();
  } else {
    agentType = rest.slice(0, sp) || undefined; // `& foo` — no agent token
    prompt = rest.slice(sp + 1).trim();
  }
  if (!prompt && agentType) {
    prompt = agentType;
    agentType = undefined;
  }
  if (!prompt) return null;
  return agentType ? { agentType, prompt } : { prompt };
}

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
  /**
   * Run the child in an isolated git worktree (~/.pi/agent/subagent-worktrees/<runId>,
   * detached from HEAD at spawn time). The child's writes never touch the caller's
   * working tree; on settle, the full change set (INCLUDING untracked files, via
   * `git add -A` + `git diff --cached`) is captured to `<runId>.patch` next to the
   * run artifact and recorded on RunRecord.worktree. Merge-back is the caller's
   * decision — central integration, not auto-merge. Fails fast (kind 'crashed')
   * when cwd is not inside a git repository.
   */
  worktree?: boolean;
  /** Owning pi session file used to group the run in operational fleet views. */
  ownerSession?: string;
  /**
   * Owning pi session file path. When set, the run is ALSO persisted as a
   * standard pi session JSONL via the real `SessionManager` into the default
   * sessions dir (~/.pi/agent/sessions/<encoded-cwd>/), with `parentSession`
   * set to this path — so the run is inspectable with pi's native /resume,
   * /tree, and --fork machinery. The bespoke run store (fleet/registry)
   * keeps working unchanged; this is an additive dual-write. Omit to disable
   * the mirror entirely (other shared-runtime consumers that don't pass an
   * owning session are unaffected).
   */
  parentSession?: string;
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

/** One line of a bounded child transcript, for post-hoc debugging. */
export interface TranscriptEntry {
  kind: 'turn' | 'tool';
  label: string;
}

/** Where a worktree-isolated run lived and what it changed. */
export interface WorktreeInfo {
  /** Worktree path (kept on disk until GC, for inspection/manual merge). */
  path: string;
  /** Main repo root the worktree belongs to, when known. */
  repoRoot?: string | undefined;
  /** Full untruncated `git diff --cached HEAD` patch file, when anything changed. */
  patchPath?: string | undefined;
  changedFiles?: number | undefined;
}

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
  /** Host pi process id — reaping distinguishes ghosts from live runs. */
  hostPid?: number | undefined;
  /** Owning pi session file, used to scope operational fleet views. */
  ownerSession?: string | undefined;
  /** Last N child events (turns/tool calls), bounded. */
  transcript?: TranscriptEntry[] | undefined;
  worktree?: WorktreeInfo | undefined;
  /**
   * Path to a standard pi session JSONL mirror of this run, when dual-written
   * via `SessionManager` (see SpawnOptions.parentSession). Additive to the
   * bespoke run store — the fleet/registry still read the .json artifact.
   */
  sessionFile?: string | undefined;
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
const MAX_TRANSCRIPT_ENTRIES = 20;
/** Persisted artifacts (and their worktrees) are GC'd after this age. */
export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// ── Process-wide child budget ─────────────────────────────────────────────
// Module-level on purpose: every extension gets its own copy of this module
// under pi's loader, so a TRUE cross-extension budget would need a file lock
// (overkill). What this does cover is the realistic stacking case — multiple
// runtimes created inside ONE extension instance (e.g. codemode spawning a
// workflow that spawns children) — and it caps each runtime's own acquire()
// below it anyway, so 3 runtimes x 4 = 12 cannot stack within one extension.
// Cross-extension stacking is bounded by the per-runtime limit.
const GLOBAL_MAX_CHILDREN = 8;
let globalActive = 0;
const globalWaiters: Array<() => void> = [];

function acquireGlobal(): Promise<void> {
  if (globalActive < GLOBAL_MAX_CHILDREN) {
    globalActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => globalWaiters.push(resolve));
}

function releaseGlobal(): void {
  globalActive--;
  const next = globalWaiters.shift();
  if (next) {
    globalActive++;
    next();
  }
}

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

/**
 * Additive dual-write: mirror a finished child run's messages into a standard
 * pi session JSONL via the real SessionManager, linked back to the owning
 * session through `parentSession`. Returns the new session file path, or
 * undefined when no mirror was written (no messages, or a best-effort
 * failure). Never throws — the bespoke .json artifact remains the source of
 * truth for the fleet/registry.
 *
 * `parentSession` is the owning pi session's file path
 * (ctx.sessionManager.getSessionFile() from the dispatch tool). When
 * undefined (in-memory/print host) the mirror is still written, just without
 * parent linkage. SessionManager.appendMessage refuses compactionSummary and
 * branchSummary messages, so those are filtered — a single-prompt child run
 * should never produce them, but the guard keeps a compacted child from
 * breaking the mirror.
 */
function writeSessionMirror(
  messages: readonly any[],
  cwd: string,
  parentSession: string | undefined,
): string | undefined {
  const safe = messages.filter((m) => {
    const role = m?.role;
    return (
      role === 'user' || role === 'assistant' || role === 'toolResult' || role === 'bashExecution' || role === 'custom'
    );
  });
  if (safe.length === 0) return undefined;
  try {
    const mgr = SessionManager.create(cwd, undefined, parentSession ? { parentSession } : undefined);
    for (const msg of safe) mgr.appendMessage(msg);
    // SessionManager creates the JSONL lazily — only once the first assistant
    // message is appended (see its _persist 'hasAssistant' gate). A child that
    // crashed before producing any assistant turn therefore leaves no file on
    // disk, and getSessionFile() would return a path to nothing. Only report a
    // sessionFile when the mirror was actually written.
    const file = mgr.getSessionFile();
    return file && fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}
export { writeSessionMirror };

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
        if (
          parsed &&
          typeof parsed.runId === 'string' &&
          typeof parsed.status === 'string' &&
          typeof parsed.promptPreview === 'string'
        ) {
          out.push(parsed as RunArtifact);
        }
      } catch {
        // skip unreadable artifact
      }
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * One GC + reaping pass over persisted run artifacts:
 * - records older than ARTIFACT_RETENTION_MS are deleted, together with their
 *   sibling `<runId>.patch` and any recorded worktree;
 * - records still 'queued'/'running' whose hostPid is not this process are
 *   ghosts of a dead host (in-process children cannot outlive it) — marked
 *   'aborted' with an explanatory error so /fleet shows the truth.
 *
 * Returns counts for observability. Never throws. Injectable `now` for tests.
 */
export function sweepRunArtifacts(
  rootDir: string,
  opts: { now?: number; retentionMs?: number } = {},
): { deleted: number; reaped: number } {
  const now = opts.now ?? Date.now();
  const retentionMs = opts.retentionMs ?? ARTIFACT_RETENTION_MS;
  let deleted = 0;
  let reaped = 0;
  let namespaces: fs.Dirent[];
  try {
    namespaces = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return { deleted, reaped };
  }
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
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const filePath = path.join(dir, file.name);
      let record: RunArtifact;
      try {
        record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunArtifact;
      } catch {
        continue; // unreadable — left for retention GC by mtime another day
      }
      if (!record || typeof record.runId !== 'string') continue;

      const isGhost =
        (record.status === 'running' || record.status === 'queued') &&
        typeof record.hostPid === 'number' &&
        record.hostPid !== process.pid;
      if (isGhost) {
        try {
          // A ghost run's host died before runChild could clean up — remove
          // its worktree now so a hard exit (SIGKILL/crash) can't leak one.
          // .patch siblings are reaped by the age-based GC below when their
          // artifact ages out; an aborted run captures no patch, so there is
          // usually nothing to reap here.
          if (record.worktree?.path) removeWorktree(record.worktree.repoRoot ?? null, record.worktree.path);
          record.status = 'aborted';
          record.endedAt = now;
          record.error =
            'Host pi process exited while this run was active (in-process children cannot outlive their host).';
          if (record.worktree?.path) record.worktree = undefined;
          fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
          reaped++;
        } catch {
          // best-effort
        }
        continue;
      }

      const age = now - (record.endedAt ?? record.startedAt ?? 0);
      if (age <= retentionMs) continue;
      try {
        if (record.worktree?.path) removeWorktree(record.worktree.repoRoot ?? null, record.worktree.path);
        fs.rmSync(filePath, { force: true });
        fs.rmSync(filePath.replace(/\.json$/, '.patch'), { force: true });
        deleted++;
      } catch {
        // best-effort
      }
    }
  }
  return { deleted, reaped };
}

let sweptThisProcess = false;
/** Run sweepRunArtifacts once per host process (each extension loads its own copy; cheap and idempotent). */
export function sweepRunArtifactsOnce(rootDir: string): void {
  if (sweptThisProcess) return;
  sweptThisProcess = true;
  try {
    sweepRunArtifacts(rootDir);
  } catch {
    // never block startup on GC
  }
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
    const ownerSession = opts.ownerSession ?? opts.parentSession;
    if (ownerSession) record.ownerSession = ownerSession;
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
    await acquireGlobal();
    record.status = 'running';
    record.hostPid = process.pid;
    persist(record);
    try {
      return await runChild(runId, opts, startedAt, record);
    } finally {
      release();
      releaseGlobal();
    }
  }

  async function runChild(
    runId: string,
    opts: SpawnOptions,
    startedAt: number,
    record: RunRecord,
  ): Promise<SpawnResult> {
    let cwd = opts.cwd ?? process.cwd();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Worktree isolation: the child writes into a detached worktree, never
    // the caller's tree. Handoff (full patch incl. untracked files) is
    // captured at settle; merge-back is the caller's decision.
    if (opts.worktree) {
      const repoRoot = findRepoRoot(cwd);
      if (!repoRoot) {
        return markFailed(
          record,
          fail(runId, 'crashed', `worktree requested but ${cwd} is not inside a git repository`, startedAt),
        );
      }
      const added = addWorktree(repoRoot, runId);
      if ('error' in added) {
        return markFailed(record, fail(runId, 'crashed', `worktree setup failed: ${added.error}`, startedAt));
      }
      record.worktree = { path: added.path, repoRoot };
      cwd = added.path;
    }

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
    const transcript: TranscriptEntry[] = [];
    session.subscribe((event: AgentSessionEvent) => {
      // Typed narrowing: a pi event rename fails the build here instead of
      // silently disabling budget enforcement.
      switch (event.type) {
        case 'turn_start': {
          turnCount++;
          transcript.push({ kind: 'turn', label: `turn ${turnCount}` });
          if (opts.maxTurns !== undefined && turnCount > opts.maxTurns) {
            abortOnce(`Turn budget exceeded (${opts.maxTurns})`);
          }
          break;
        }
        case 'tool_execution_start': {
          toolCallCount++;
          const toolName =
            typeof (event as { toolName?: unknown }).toolName === 'string'
              ? ((event as { toolName?: string }).toolName as string)
              : 'tool';
          transcript.push({ kind: 'tool', label: toolName });
          if (opts.maxToolCalls !== undefined && toolCallCount > opts.maxToolCalls) {
            abortOnce(`Tool-call budget exceeded (${opts.maxToolCalls})`);
          }
          break;
        }
      }
      if (transcript.length > MAX_TRANSCRIPT_ENTRIES) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ENTRIES);
      // Mirror onto the record so /fleet can show live activity mid-run
      // (transcript/usage otherwise only exist after settle).
      record.transcript = [...transcript];
    });

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
    // Worktree handoff/cleanup policy:
    // - A run that did NOT abort (completed/failed/empty/schema_invalid)
    //   captures its full patch (incl. untracked files) beside the artifact;
    //   the worktree itself is kept on disk for the 7-day inspection window
    //   and removed by sweepRunArtifacts alongside the aged-out artifact.
    // - An aborted run (signal/cancel/host-shutdown) never captures a patch:
    //   the child did not complete, so its partial tree is not a reliable
    //   handoff. Its worktree is removed immediately so an interrupt or
    //   parent exit can never leak a detached worktree. The worktree path is
    //   dropped from the record so /fleet never advertises a path that no
    //   longer exists.
    if (record.worktree) {
      if (abortReason !== undefined) {
        removeWorktree(record.worktree.repoRoot ?? null, record.worktree.path);
        record.worktree = undefined;
      } else if (artifactsDir) {
        try {
          const dir = path.join(artifactsDir, namespace);
          fs.mkdirSync(dir, { recursive: true });
          const handoff = captureHandoff(record.worktree.path, path.join(dir, `${runId}.patch`));
          if (handoff.patchPath) record.worktree.patchPath = handoff.patchPath;
          record.worktree.changedFiles = handoff.changedFiles;
        } catch {
          // handoff capture is best-effort; the worktree path on the record is the fallback
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    record.endedAt = Date.now();
    record.usage = usage;
    if (transcript.length > 0) record.transcript = [...transcript];

    // Additive dual-write: mirror the run into a standard pi session JSONL via
    // the real SessionManager, with parentSession linked to the owning session.
    // This is independent of the bespoke .json artifact above (which the
    // fleet/registry still read); failures here must never fail the run.
    // Opt-in via SpawnOptions.parentSession so other shared-runtime consumers
    // (codemode/workflow) that don't pass an owning session are unaffected.
    record.sessionFile =
      opts.parentSession !== undefined ? writeSessionMirror(messages, cwd, opts.parentSession) : undefined;

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
