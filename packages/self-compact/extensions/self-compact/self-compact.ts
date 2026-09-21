/**
 * Durable self-compaction lifecycle.
 *
 * Exposes a single `self_compact({ note_to_self })` tool. When the model calls
 * it, the extension:
 *   1. Validates and durably persists the note plus a snapshot of the currently
 *      active tools, then locks the agent to only `self_compact` (both by
 *      restricting active tools and by a `tool_call` gate).
 *   2. Lets the current tool batch terminate cleanly.
 *   3. Once the agent is genuinely idle, requests compaction. The summary system
 *      instruction is replaced (see prompts.ts) and failures cancel compaction
 *      while keeping the note and lock intact — never a silent fallback.
 *   4. After a successful compaction, restores the prior tool selection and
 *      delivers the original note verbatim as a continuation message so the
 *      agent resumes its unfinished work without another human prompt.
 *
 * State lives in branch-local named custom entries, so ordinary reload/resume
 * reconstructs it, branch navigation isolates it, and a delivered handoff is not
 * replayed. Exactly-once external effects across arbitrary crashes are not
 * promised.
 */
import { uuidv7 } from '@earendil-works/pi-ai';
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  DEFAULT_AT,
  DEFAULT_BUFFER,
  DEFAULT_SOFT_AT,
  FLAG_AT,
  FLAG_BUFFER,
  FLAG_PROMPT,
  FLAG_SOFT_AT,
  resolveThresholds,
  tokensToPercent,
  type ConfigResult,
  type FlagInputs,
} from './config.js';
import { contextBarLine, latestApplicableCacheRead } from './bar.js';
import {
  COMPACTION_MESSAGE_FILE,
  SOFT_SELF_COMPACT_FILE,
  WARNING_SELF_COMPACT_FILE,
  loadDefaultCompactionInstruction,
  packageResourceDir,
  renderGuidance,
  runSelfCompaction,
  type GuidanceLevel,
  type GuidanceValues,
} from './prompts.js';

export const TOOL_NAME = 'self_compact';
export const STATE_ENTRY = 'self-compact:state';
export const DELIVERY_ENTRY = 'self-compact:delivered';
export const NOTIFY_ENTRY = 'self-compact:notify';
export const HARD_ENTRY = 'self-compact:hard';
export const CONTINUATION_MESSAGE_TYPE = 'self-compact:continuation';
export const WIDGET_KEY = 'self-compact';
export const INFO_COMMAND = 'self-compact-info';
export const NOW_COMMAND = 'self-compact-now';
export const MAX_NOTE_LENGTH = 24000;

export type ThresholdLevel = 'none' | 'soft' | 'warning' | 'hard';
const LEVEL_RANK: Record<ThresholdLevel, number> = { none: 0, soft: 1, warning: 2, hard: 3 };

interface NotifyState {
  level: ThresholdLevel;
  cycle: number;
}

interface HardEntryState {
  active: boolean;
  originalActiveTools: string[];
}

export type HandoffPhase = 'pending' | 'compacting' | 'failed' | 'ready-to-deliver' | 'delivered';

export interface HandoffState {
  cycleId: string;
  phase: HandoffPhase;
  /** The original note, verbatim. Immutable across retries within a cycle. */
  note: string;
  /** Tool selection captured when the cycle began, restored after success. */
  originalActiveTools: string[];
  completedCycles: number;
  sessionId?: string;
  lastError?: string;
}

const noteSchema = Type.Object({
  note_to_self: Type.String({
    description:
      'The exact next action to resume after compaction. Preserved verbatim and re-delivered to you once the context has been compacted.',
  }),
});

export type NoteValidation = { ok: true; note: string } | { ok: false; error: string };

/** Validate a note without trimming or reformatting the content that is saved. */
export function validateNote(note: unknown): NoteValidation {
  if (typeof note !== 'string') return { ok: false, error: 'note_to_self must be a string' };
  if (note.trim().length === 0) return { ok: false, error: 'note_to_self must not be blank' };
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `note_to_self must be at most ${MAX_NOTE_LENGTH} characters (received ${note.length})` };
  }
  return { ok: true, note };
}

type CustomEntryLike = SessionEntry & { type: 'custom'; customType: string; data?: unknown };

function isCustomEntry(entry: SessionEntry, customType: string): entry is CustomEntryLike {
  return entry.type === 'custom' && (entry as CustomEntryLike).customType === customType;
}

/** Latest handoff state on the branch, or undefined if there is none. */
export function readHandoffState(entries: SessionEntry[]): HandoffState | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && isCustomEntry(entry, STATE_ENTRY)) {
      const data = entry.data;
      if (data && typeof data === 'object') return data as HandoffState;
    }
  }
  return undefined;
}

/** Cycle IDs that already had a continuation delivered on this branch. */
export function readDeliveredCycleIds(entries: SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (isCustomEntry(entry, DELIVERY_ENTRY)) {
      const data = entry.data as { cycleId?: unknown } | undefined;
      if (data && typeof data.cycleId === 'string') ids.add(data.cycleId);
    }
  }
  return ids;
}

/** Latest persisted guidance-notification state on this branch. */
export function readNotifyState(entries: SessionEntry[]): NotifyState | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && isCustomEntry(entry, NOTIFY_ENTRY)) {
      const data = entry.data as { level?: unknown; cycle?: unknown } | undefined;
      if (
        data &&
        (data.level === 'none' || data.level === 'soft' || data.level === 'warning' || data.level === 'hard') &&
        typeof data.cycle === 'number'
      ) {
        return { level: data.level, cycle: data.cycle };
      }
    }
  }
  return undefined;
}

/** Latest persisted hard-enforcement snapshot on this branch. */
export function readHardState(entries: SessionEntry[]): HardEntryState | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && isCustomEntry(entry, HARD_ENTRY)) {
      const data = entry.data as { active?: unknown; originalActiveTools?: unknown } | undefined;
      if (data && typeof data.active === 'boolean' && Array.isArray(data.originalActiveTools)) {
        return {
          active: data.active,
          originalActiveTools: data.originalActiveTools.filter((n): n is string => typeof n === 'string'),
        };
      }
    }
  }
  return undefined;
}

interface AssistantToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool calls in the most recent assistant message that carries any tool call. */
function currentBatchCalls(entries: SessionEntry[]): { messageId: string; calls: AssistantToolCall[] } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const calls: AssistantToolCall[] = [];
    for (const c of content) {
      if (!c || typeof c !== 'object' || (c as { type?: unknown }).type !== 'toolCall') continue;
      const tc = c as { name?: unknown; arguments?: unknown };
      if (typeof tc.name !== 'string') continue;
      calls.push({ name: tc.name, arguments: (tc.arguments as Record<string, unknown> | undefined) ?? {} });
    }
    if (calls.length > 0) return { messageId: entry.id, calls };
    return undefined;
  }
  return undefined;
}

function isLockedPhase(phase: HandoffPhase): boolean {
  return phase === 'pending' || phase === 'compacting' || phase === 'failed' || phase === 'ready-to-deliver';
}

export default function (pi: ExtensionAPI) {
  // In-memory coordination only. Durable truth lives in branch custom entries.
  let busy = false;
  let lastReservedMessageId: string | undefined;
  let disposed = false;
  let sessionId: string | undefined;
  // Resolved threshold configuration for the current model, or an error when the
  // flags cannot fit the window. Fail-closed enforcement reads this.
  let config: ConfigResult | undefined;
  // Hard-enforcement visibility state, mirrored durably in HARD_ENTRY.
  let hardActive = false;
  let hardOriginalTools: string[] | undefined;
  let toolsBeforeTree: string[] | undefined;
  // Timers scheduling a post-reconciliation delivery, cleared on shutdown so a
  // late callback cannot touch a replaced session.
  const reconcileTimers = new Set<ReturnType<typeof setTimeout>>();

  function flagString(name: string): string {
    const value = pi.getFlag(name);
    return typeof value === 'string' ? value : '';
  }

  function flagOptional(name: string): string | undefined {
    const value = pi.getFlag(name);
    return typeof value === 'string' ? value : undefined;
  }

  /** Resolve flags against the current model window; notify on an invalid ordering. */
  /** Compute (without side effects) the threshold config for the current model. */
  function computeConfig(ctx: ExtensionContext): ConfigResult {
    const window = ctx.model?.contextWindow;
    if (typeof window !== 'number') {
      return { ok: false, error: 'self-compact: no model selected; cannot resolve thresholds' };
    }
    const inputs: FlagInputs = {
      softAt: flagString(FLAG_SOFT_AT),
      at: flagString(FLAG_AT),
      buffer: flagString(FLAG_BUFFER),
      compactPrompt: flagOptional(FLAG_PROMPT),
    };
    return resolveThresholds(inputs, window);
  }

  /** Re-resolve flags against the current model window; notify on an invalid ordering. */
  function resolveConfig(ctx: ExtensionContext): void {
    config = computeConfig(ctx);
    if (!config.ok) ctx.ui.notify(config.error, 'error');
  }

  /**
   * Resolve lazily the first time the config is needed. `session_start` does not
   * fire on a fresh SDK `createAgentSession`, so the gates, widget, and commands
   * must be able to resolve on their own first use.
   */
  function ensureConfig(ctx: ExtensionContext): void {
    if (config === undefined) resolveConfig(ctx);
  }

  function persistHard(state: HardEntryState): void {
    try {
      pi.appendEntry(HARD_ENTRY, state);
    } catch {
      // Best effort: in-memory state still enforces via the tool_call gate.
    }
  }

  function persistNotify(state: NotifyState): void {
    try {
      pi.appendEntry(NOTIFY_ENTRY, state);
    } catch {
      // Best effort: at worst a level is re-announced after a reload.
    }
  }

  /** Snapshot of ordinary active tools, preferring a pre-hard snapshot when locked. */
  function activeToolsSnapshot(): string[] {
    if (hardActive && hardOriginalTools) return [...hardOriginalTools];
    return [...pi.getActiveTools()];
  }

  function branch(ctx: ExtensionContext): SessionEntry[] {
    try {
      return ctx.sessionManager.getBranch();
    } catch {
      // The ctx is stale (session was shut down/replaced). A late callback must
      // not touch a new session: report no state so the coordinator no-ops.
      return [];
    }
  }

  function currentState(ctx: ExtensionContext): HandoffState | undefined {
    return readHandoffState(branch(ctx));
  }

  function persist(state: HandoffState): void {
    // A persistence failure must surface as failure: let it throw so callers
    // keep the in-memory lock and report an error rather than success.
    pi.appendEntry(STATE_ENTRY, state);
  }

  function registeredToolNames(): Set<string> {
    return new Set(pi.getAllTools().map((t) => t.name));
  }

  function lockTools(): void {
    pi.setActiveTools([TOOL_NAME]);
  }

  function restoreTools(state: HandoffState): void {
    const registered = registeredToolNames();
    const restored = state.originalActiveTools.filter((name) => registered.has(name));
    pi.setActiveTools(restored);
  }

  /**
   * Validate, persist, and lock a handoff. Idempotent across the batch/retry:
   * an existing cycle with the same note is reused; a different note is rejected
   * while the previous handoff is still pending.
   */
  function reserveHandoff(rawNote: unknown, ctx: ExtensionContext): NoteValidation {
    const validation = validateNote(rawNote);
    if (!validation.ok) return validation;

    const existing = currentState(ctx);
    if (existing && isLockedPhase(existing.phase)) {
      if (existing.note !== validation.note) {
        return {
          ok: false,
          error:
            'A different self_compact handoff is already pending; complete or recover it before replacing the note.',
        };
      }
      if (existing.phase === 'failed') {
        // Explicit retry with the unchanged note: re-arm the same cycle and
        // clear the recorded error, keeping the original tool snapshot.
        const rearmed: HandoffState = {
          cycleId: existing.cycleId,
          phase: 'pending',
          note: existing.note,
          originalActiveTools: existing.originalActiveTools,
          completedCycles: existing.completedCycles,
          ...(existing.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
        };
        persist(rearmed);
      }
      // Same note, retry/reload: keep the original snapshot and cycle intact.
      lockTools();
      return validation;
    }

    const active = activeToolsSnapshot();
    const state: HandoffState = {
      cycleId: uuidv7(),
      phase: 'pending',
      note: validation.note,
      originalActiveTools: active,
      completedCycles: existing?.completedCycles ?? 0,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    persist(state);
    // The handoff now owns tool restoration; drop the standalone hard snapshot.
    clearHard();
    lockTools();
    return validation;
  }

  /** Restrict tools to self_compact at the hard crossing, snapshotting the prior selection. */
  function enterHard(): void {
    if (hardActive) return;
    hardOriginalTools = [...pi.getActiveTools()];
    hardActive = true;
    persistHard({ active: true, originalActiveTools: hardOriginalTools });
    lockTools();
  }

  /** Restore the pre-hard tool selection after successful native compaction. */
  function exitHard(): void {
    if (!hardActive) return;
    const restore = hardOriginalTools ?? [];
    clearHard();
    const registered = registeredToolNames();
    pi.setActiveTools(restore.filter((name) => registered.has(name)));
  }

  function clearHard(): void {
    const wasActive = hardActive || hardOriginalTools !== undefined;
    hardActive = false;
    hardOriginalTools = undefined;
    if (wasActive) persistHard({ active: false, originalActiveTools: [] });
  }

  /**
   * Deliver the continuation for a compacted cycle. Returns true when it
   * actually triggered a continuation turn (so the caller can await it), false
   * when there was nothing to deliver (disposed, or already delivered).
   */
  function deliver(ctx: ExtensionContext, state: HandoffState): boolean {
    if (disposed) return false;
    const delivered = readDeliveredCycleIds(branch(ctx));
    if (delivered.has(state.cycleId) || state.phase === 'delivered') return false;

    restoreTools(state);
    // Successful compaction ends hard enforcement and resets guidance tracking
    // (the completedCycles bump makes prior NOTIFY_ENTRY stale for the new cycle).
    clearHard();
    updateWidget(ctx);

    const continuation = [
      state.note,
      '',
      '<self-compact-continuation>',
      'The conversation above was compacted to reclaim context. Your saved note is reproduced verbatim above this block; it is not part of the summary.',
      'Resume from where you left off: perform only the unfinished next actions the note describes. Do not restart work that is already complete. Report when the remaining work is done.',
      '</self-compact-continuation>',
    ].join('\n');

    pi.appendEntry(DELIVERY_ENTRY, { cycleId: state.cycleId });
    persist({ ...state, phase: 'delivered', completedCycles: state.completedCycles + 1 });

    // Triggers a fresh continuation turn. `sendMessage` is fire-and-forget, so
    // the caller keeps the agent busy and awaits idle (see deliverAndAwait) to
    // stop `pi -p`/JSON from disposing the process before it completes.
    pi.sendMessage(
      {
        customType: CONTINUATION_MESSAGE_TYPE,
        content: continuation,
        display: true,
        details: { cycleId: state.cycleId },
      },
      { triggerTurn: true, deliverAs: 'followUp' },
    );
    return true;
  }

  /**
   * Deliver, then block until the continuation turn settles. Called only while
   * `busy` is held, so a re-entrant `agent_settled` from the continuation turn
   * short-circuits. Awaiting here keeps the outer `agent_settled` handler (and
   * thus `session.prompt`) pending until the continuation finishes, which is
   * what prevents print/JSON single-shot modes from exiting early.
   */
  async function deliverAndAwait(ctx: ExtensionContext, state: HandoffState): Promise<void> {
    try {
      const started = deliver(ctx, state);
      if (started) await waitForContinuationIdle(ctx);
    } finally {
      busy = false;
      lastReservedMessageId = undefined;
    }
    // A continuation may itself checkpoint. Its re-entrant settled handler ran
    // under busy, so drive that new pending cycle once the outer turn is idle.
    if (!disposed) await coordinate(ctx);
  }

  /**
   * Wait until the just-triggered continuation turn settles. The continuation
   * runs as a detached turn (`sendMessage` returns no promise), so poll the
   * public idle check rather than awaiting an internal promise. Never awaits
   * `waitForIdle` (unavailable on the settled ctx and prone to deadlock).
   */
  async function waitForContinuationIdle(ctx: ExtensionContext): Promise<void> {
    // A valid continuation can run for minutes. Returning on an arbitrary
    // deadline lets print mode dispose an otherwise healthy active task.
    while (!disposed) {
      let idle: boolean;
      try {
        idle = ctx.isIdle();
      } catch {
        return; // ctx went stale (session replaced/shut down); nothing to await.
      }
      if (idle) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Request compaction and resolve/reject once it completes or fails. */
  function compactOnce(ctx: ExtensionContext): Promise<void> {
    return new Promise((resolve, reject) => {
      ctx.compact({
        onComplete: () => resolve(),
        onError: (error) => reject(error instanceof Error ? error : new Error(String(error))),
      });
    });
  }

  function alreadyFailed(ctx: ExtensionContext, cycleId: string): boolean {
    const state = currentState(ctx);
    return !!state && state.cycleId === cycleId && state.phase === 'failed';
  }

  /**
   * Drive a pending cycle to completion: compact, then deliver and await the
   * continuation. Awaited by `agent_settled` so the whole lifecycle finishes
   * before the settled handler returns.
   */
  async function compactThenDeliver(ctx: ExtensionContext, cycleId: string): Promise<void> {
    try {
      await compactOnce(ctx);
    } catch (error) {
      if (disposed || alreadyFailed(ctx, cycleId)) {
        busy = false;
        return;
      }
      const state = currentState(ctx);
      if (state && state.cycleId === cycleId) recordFailure(ctx, state, error);
      else busy = false;
      return;
    }
    if (disposed) {
      busy = false;
      return;
    }
    const state = currentState(ctx);
    if (!state || state.cycleId !== cycleId) {
      busy = false;
      return;
    }
    await deliverAndAwait(ctx, { ...state, phase: 'ready-to-deliver' });
  }

  function recordFailure(ctx: ExtensionContext, state: HandoffState, error: unknown): void {
    busy = false;
    const message = error instanceof Error ? error.message : String(error);
    try {
      persist({ ...state, phase: 'failed', lastError: message });
    } catch {
      // Keep the in-memory lock; the durable note from the pending phase remains.
    }
    lockTools();
    ctx.ui.notify(`self-compact: compaction failed and the handoff remains locked: ${message}`, 'error');
  }

  /**
   * Drive delivery of a reconciled handoff without a fresh user prompt. Retries
   * briefly because the triggering compaction may still be clearing (not yet
   * idle) when this first runs. Each pass is a no-op unless idle and still
   * ready-to-deliver, and coordinate()/deliver() are idempotent.
   */
  function scheduleReconciledDelivery(ctx: ExtensionContext, attempt = 0): void {
    if (disposed || attempt > 50) return;
    const timer = setTimeout(() => {
      reconcileTimers.delete(timer);
      if (disposed) return;
      const state = currentState(ctx);
      if (!state || state.phase !== 'ready-to-deliver') return; // delivered or superseded
      if (busy || !safeIsIdle(ctx)) {
        scheduleReconciledDelivery(ctx, attempt + 1);
        return;
      }
      void coordinate(ctx);
    }, 20);
    reconcileTimers.add(timer);
  }

  function safeIsIdle(ctx: ExtensionContext): boolean {
    try {
      return ctx.isIdle();
    } catch {
      return false;
    }
  }

  async function coordinate(ctx: ExtensionContext): Promise<void> {
    if (disposed || busy) return;
    const state = currentState(ctx);
    if (!state) return;

    if (state.phase === 'ready-to-deliver') {
      if (!ctx.isIdle()) return;
      busy = true;
      await deliverAndAwait(ctx, state);
      return;
    }

    if (state.phase === 'pending') {
      if (!ctx.isIdle()) return;
      if (state.sessionId !== undefined && sessionId !== undefined && state.sessionId !== sessionId) return;
      busy = true;
      try {
        persist({ ...state, phase: 'compacting' });
      } catch (error) {
        recordFailure(ctx, state, error);
        return;
      }
      await compactThenDeliver(ctx, state.cycleId);
      return;
    }
    // 'compacting' is in-flight; 'failed'/'delivered' require explicit action.
  }

  /** Current measured context tokens, or null when unknown (e.g. post-compaction). */
  function measuredTokens(ctx: ExtensionContext): number | null {
    try {
      const usage = ctx.getContextUsage();
      return usage && typeof usage.tokens === 'number' ? usage.tokens : null;
    } catch {
      return null;
    }
  }

  /** Refresh the above-editor context widget. Clears/no-ops without UI. */
  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ensureConfig(ctx);
    if (!config || !config.ok) {
      ctx.ui.setWidget(WIDGET_KEY, ['self-compact: thresholds not configured (see notice)'], {
        placement: 'aboveEditor',
      });
      return;
    }
    const t = config.thresholds;
    const tokens = measuredTokens(ctx);
    // Cached tokens describe the current prompt only, bounded by measured usage.
    let cachedTokens: number | null = null;
    if (tokens !== null) {
      const cacheRead = latestApplicableCacheRead(branch(ctx));
      cachedTokens = cacheRead === null ? null : Math.min(cacheRead, tokens);
    }
    const line = contextBarLine(
      { tokens, cachedTokens },
      {
        softTokens: t.softTokens,
        warningTokens: t.warningTokens,
        hardTokens: t.hardTokens,
        contextWindow: t.contextWindow,
      },
    );
    ctx.ui.setWidget(WIDGET_KEY, [line], { placement: 'aboveEditor' });
  }

  function currentLevel(tokens: number): ThresholdLevel {
    if (!config || !config.ok) return 'none';
    const t = config.thresholds;
    if (tokens >= t.hardTokens) return 'hard';
    if (tokens >= t.warningTokens) return 'warning';
    if (tokens >= t.softTokens) return 'soft';
    return 'none';
  }

  function guidanceValues(tokens: number): GuidanceValues | undefined {
    if (!config || !config.ok) return undefined;
    const t = config.thresholds;
    return {
      tokens,
      percent: tokensToPercent(tokens, t.contextWindow),
      context_window: t.contextWindow,
      soft_tokens: t.softTokens,
      warning_tokens: t.warningTokens,
      hard_tokens: t.hardTokens,
      hard_percent: tokensToPercent(t.hardTokens, t.contextWindow),
    };
  }

  /** Inject soft/warning guidance without ever starting a turn just to show it. */
  function deliverGuidance(ctx: ExtensionContext, level: GuidanceLevel, tokens: number): void {
    if (disposed) return;
    const values = guidanceValues(tokens);
    if (!values) return;
    let content: string;
    try {
      content = renderGuidance(level, values);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    const idle = safeIsIdle(ctx);
    pi.sendMessage(
      { customType: `self-compact:guidance-${level}`, content, display: true },
      { triggerTurn: false, deliverAs: idle ? 'nextTurn' : 'steer' },
    );
  }

  /**
   * Evaluate current usage at a request/turn/tool boundary: refresh the widget,
   * enforce or release the hard cutoff, and emit at most the strongest new
   * guidance level once per compaction cycle. Unknown usage waits for a real
   * measurement; it never fabricates a zero or a lock.
   */
  function evaluateThresholds(ctx: ExtensionContext): void {
    ensureConfig(ctx);
    updateWidget(ctx);
    if (!config || !config.ok) return;

    const handoff = currentState(ctx);
    const handoffLocked = handoff ? isLockedPhase(handoff.phase) : false;
    if (handoffLocked) return; // the handoff lock owns tool state during a cycle

    const tokens = measuredTokens(ctx);
    if (tokens === null) return; // unknown: wait for a valid measurement

    const level = currentLevel(tokens);

    if (level === 'hard') enterHard();

    if (level === 'none') return;
    const cycle = handoff?.completedCycles ?? 0;
    const last = readNotifyState(branch(ctx));
    const notifiedRank = last && last.cycle === cycle ? LEVEL_RANK[last.level] : 0;
    if (LEVEL_RANK[level] <= notifiedRank) return; // already announced this level (or stronger)
    persistNotify({ level, cycle });
    // Hard enforcement is delivered through the tool_call gate; soft/warning are
    // advisory model-facing messages. A direct jump to hard therefore emits no
    // soft/warning cascade.
    if (level === 'soft' || level === 'warning') deliverGuidance(ctx, level, tokens);
  }

  pi.registerFlag(FLAG_SOFT_AT, {
    type: 'string',
    default: DEFAULT_SOFT_AT,
    description: 'Optional heads-up threshold: tokens (e.g. 225k) or a window percentage (e.g. 60%).',
  });
  pi.registerFlag(FLAG_AT, {
    type: 'string',
    default: DEFAULT_AT,
    description: 'Warning threshold at which to save a note and self-compact.',
  });
  pi.registerFlag(FLAG_BUFFER, {
    type: 'string',
    default: DEFAULT_BUFFER,
    description: 'Additional tokens or percentage points past --compact-at before ordinary tools are paused.',
  });
  pi.registerFlag(FLAG_PROMPT, {
    type: 'string',
    description: 'Literal summary system instruction that replaces the editable default for every compaction.',
  });

  /** Build the human-readable diagnostics for /self-compact-info. */
  function buildInfoReport(ctx: ExtensionContext): string {
    ensureConfig(ctx);
    const lines: string[] = ['self-compact info:'];
    lines.push(
      `  flags: --compact-soft-at=${flagString(FLAG_SOFT_AT)} --compact-at=${flagString(FLAG_AT)} --compact-buffer=${flagString(FLAG_BUFFER)}`,
    );
    const promptFlag = flagOptional(FLAG_PROMPT);
    lines.push(
      `  --compact-prompt: ${promptFlag === undefined ? '(unset; using default file)' : 'literal override set'}`,
    );
    const promptDir = packageResourceDir();
    lines.push(
      `  summary prompt: ${promptFlag === undefined ? `${promptDir}/${COMPACTION_MESSAGE_FILE}` : '--compact-prompt (literal)'}`,
    );
    lines.push(`  soft prompt: ${promptDir}/${SOFT_SELF_COMPACT_FILE}`);
    lines.push(`  warning prompt: ${promptDir}/${WARNING_SELF_COMPACT_FILE}`);
    const window = ctx.model?.contextWindow;
    lines.push(`  model window: ${typeof window === 'number' ? window : 'unknown'}`);
    if (config && config.ok) {
      const t = config.thresholds;
      lines.push(
        `  resolved: soft=${t.softTokens} (${tokensToPercent(t.softTokens, t.contextWindow)}%), ` +
          `warning=${t.warningTokens} (${tokensToPercent(t.warningTokens, t.contextWindow)}%), ` +
          `hard=${t.hardTokens} (${tokensToPercent(t.hardTokens, t.contextWindow)}%), max=${t.cap}`,
      );
    } else {
      lines.push(`  resolved: INVALID — ${config?.error ?? 'not resolved yet'}`);
    }
    const tokens = measuredTokens(ctx);
    const cacheRead = latestApplicableCacheRead(branch(ctx));
    lines.push(
      `  usage: ${tokens === null ? 'unknown' : `${tokens} tokens`}, cacheRead: ${cacheRead === null ? 'unknown' : cacheRead}`,
    );
    const state = currentState(ctx);
    lines.push(`  handoff: ${state ? `${state.phase} (cycle ${state.cycleId})` : 'none'}`);
    lines.push(`  completed cycles: ${state?.completedCycles ?? 0}`);
    lines.push(`  hard enforced: ${hardActive}`);
    if (state?.lastError) lines.push(`  last error: ${state.lastError}`);
    if (state?.note !== undefined) {
      const note = state.note;
      const shown = note.length > 500 ? `${note.slice(0, 500)}… (${note.length} chars total)` : note;
      lines.push(`  ${state.phase === 'delivered' ? 'delivered' : 'pending'} note: ${shown}`);
    }
    return lines.join('\n');
  }

  pi.registerCommand(INFO_COMMAND, {
    description: 'Show self-compaction thresholds, usage, and handoff state (does not call the model).',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(buildInfoReport(ctx), 'info');
    },
  });

  pi.registerCommand(NOW_COMMAND, {
    description: 'Ask the agent to checkpoint and self-compact now (retries a pending note verbatim).',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ensureConfig(ctx);
      if (!config || !config.ok) {
        ctx.ui.notify(config?.error ?? 'self-compact: thresholds not configured', 'error');
        return;
      }
      const state = currentState(ctx);
      if (state && (state.phase === 'compacting' || state.phase === 'ready-to-deliver')) {
        ctx.ui.notify('self-compact: a compaction is already in progress.', 'info');
        return;
      }
      let content: string;
      if (state && (state.phase === 'pending' || state.phase === 'failed')) {
        content = [
          'Retry the pending self-compaction now. Call self_compact as your only action, passing exactly this saved note_to_self verbatim:',
          '',
          state.note,
        ].join('\n');
      } else {
        content =
          'Finish or safely pause your current step, write a precise note_to_self with the exact next action to resume, then call self_compact as your only action.';
      }
      const idle = safeIsIdle(ctx);
      // Idle: start a fresh turn asking the model to checkpoint. Busy: queue a
      // follow-up so we never launch a concurrent compaction or duplicate cycle.
      pi.sendMessage(
        { customType: 'self-compact:manual-request', content, display: true },
        idle ? { triggerTurn: true } : { triggerTurn: false, deliverAs: 'followUp' },
      );
      ctx.ui.notify('self-compact: requested a checkpoint.', 'info');
    },
  });

  pi.registerTool(
    defineTool({
      name: TOOL_NAME,
      label: 'Self-Compact',
      description:
        'Checkpoint this session: save the exact next action you want to resume, then compact the conversation once idle and continue automatically. Call this as your sole action when the context is getting large.',
      promptSnippet: 'Checkpoint and compact the session, resuming from a saved note',
      promptGuidelines: [
        'Call self_compact as your only action in that turn when you decide to compact; do not pair it with other tool calls.',
        'Put the exact next action to resume into self_compact note_to_self; it is delivered back to you verbatim after compaction.',
      ],
      parameters: noteSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const validation = reserveHandoff(params.note_to_self, ctx);
        if (!validation.ok) {
          throw new Error(validation.error);
        }
        return {
          content: [
            {
              type: 'text',
              text: 'Handoff recorded. The session will compact once idle, then resume from your note. Do not take further actions this turn.',
            },
          ],
          details: { note: validation.note },
          terminate: true,
        };
      },
    }),
  );

  // Batch-aware reservation and sibling gating. Runs during preflight, before
  // siblings execute, regardless of source order.
  pi.on('tool_call', async (event, ctx) => {
    const batch = currentBatchCalls(branch(ctx));
    const selfCall = batch?.calls.find((c) => c.name === TOOL_NAME);

    if (batch && selfCall) {
      if (lastReservedMessageId !== batch.messageId) {
        const validation = reserveHandoff(selfCall.arguments.note_to_self, ctx);
        if (validation.ok) lastReservedMessageId = batch.messageId;
      }
    }

    const state = currentState(ctx);
    const locked = state ? isLockedPhase(state.phase) : false;
    if (locked && event.toolName !== TOOL_NAME) {
      return {
        block: true,
        reason: 'A self_compact handoff is pending; other tools are paused until compaction completes.',
        terminate: true,
      };
    }

    // Fail-closed and hard-cutoff execution gates. self_compact itself is always
    // allowed so the agent can still checkpoint out of an over-budget state.
    if (event.toolName !== TOOL_NAME) {
      ensureConfig(ctx);
      if (config && !config.ok) {
        return { block: true, reason: config.error, terminate: true };
      }
      if (config && config.ok) {
        const tokens = measuredTokens(ctx);
        if (hardActive || (tokens !== null && tokens >= config.thresholds.hardTokens)) {
          // Restrict the visible tool selection too, snapshotting the original.
          enterHard();
          return {
            block: true,
            reason:
              `Context has reached the hard cutoff (${tokens} tokens, limit ${config.thresholds.hardTokens}). ` +
              'Ordinary tools are paused: call self_compact with a precise note_to_self as your only action.',
          };
        }
      }
    }
    return undefined;
  });

  function restoreBranchState(ctx: ExtensionContext): void {
    for (const timer of reconcileTimers) clearTimeout(timer);
    reconcileTimers.clear();
    disposed = false;
    busy = false;
    lastReservedMessageId = undefined;
    hardActive = false;
    hardOriginalTools = undefined;
    sessionId = ctx.sessionManager.getSessionId();

    resolveConfig(ctx);

    const state = currentState(ctx);
    const handoffLocked = state ? isLockedPhase(state.phase) : false;
    if (handoffLocked) {
      if (state?.phase === 'compacting') {
        persist({ ...state, phase: 'failed', lastError: 'Compaction was interrupted; retry the saved handoff.' });
      }
      lockTools();
    } else {
      // Reconstruct a hard-enforcement lock left on the branch by a prior run.
      const hard = readHardState(branch(ctx));
      if (hard?.active) {
        hardActive = true;
        hardOriginalTools = hard.originalActiveTools;
        lockTools();
      }
    }
    updateWidget(ctx);
    // ready-to-deliver / pending resume once the agent is idle (agent_settled).
  }

  pi.on('session_start', async (_event, ctx) => restoreBranchState(ctx));
  pi.on('session_before_tree', async (_event, ctx) => {
    const state = currentState(ctx);
    toolsBeforeTree = state && isLockedPhase(state.phase) ? [...state.originalActiveTools] : activeToolsSnapshot();
  });
  pi.on('session_tree', async (_event, ctx) => {
    if (toolsBeforeTree) {
      const registered = registeredToolNames();
      pi.setActiveTools(toolsBeforeTree.filter((name) => registered.has(name)));
      toolsBeforeTree = undefined;
    }
    restoreBranchState(ctx);
  });

  pi.on('model_select', async (_event, ctx) => {
    resolveConfig(ctx);
    evaluateThresholds(ctx);
  });

  pi.on('turn_end', async (_event, ctx) => {
    evaluateThresholds(ctx);
  });

  pi.on('tool_result', async (_event, ctx) => {
    updateWidget(ctx);
  });

  pi.on('agent_settled', async (_event, ctx) => {
    evaluateThresholds(ctx);
    await coordinate(ctx);
  });

  // Replace the summary system instruction for every compaction path (our own,
  // manual /compact, and Pi's automatic threshold/overflow). Failure cancels
  // rather than silently reverting to Pi's default compactor.
  pi.on('session_before_compact', async (event, ctx) => {
    const model = ctx.model;
    if (!model) return { cancel: true };

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(`self-compact: cannot compact without provider auth: ${auth.error}`);
      const headers: Record<string, string> | undefined = auth.headers
        ? Object.fromEntries(
            Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : undefined;
      const result = await runSelfCompaction({
        preparation: event.preparation,
        model,
        streamSimple: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
        apiKey: auth.apiKey,
        headers,
        env: auth.env,
        customInstructions: event.customInstructions,
        signal: event.signal,
        // Thread the --compact-prompt literal through every compaction path
        // (self-requested, manual /compact, and automatic). A literal always
        // wins over the default file and is never treated as a filename.
        ...(config && config.ok && config.compactPromptOverride !== undefined
          ? { compactPromptOverride: config.compactPromptOverride }
          : {}),
        loadDefault: () => loadDefaultCompactionInstruction(),
      });
      return { compaction: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Record the failure authoritatively here (before returning cancel) so the
      // note and lock are retained even if no onError callback follows a cancel.
      const state = currentState(ctx);
      if (state && (state.phase === 'compacting' || state.phase === 'pending')) {
        recordFailure(ctx, state, error);
      } else {
        ctx.ui.notify(`self-compact: summary override failed, cancelling compaction: ${message}`, 'error');
      }
      return { cancel: true };
    }
  });

  // Reconcile manual/automatic compaction with a pending handoff. Our own
  // self-requested compaction is delivered by compactThenDeliver; here we only
  // discharge a handoff that a manual `/compact` or Pi's automatic
  // threshold/overflow compaction satisfied, marking it ready so delivery
  // happens once idle.
  //
  // A failed cycle needs explicit recovery: either retry self_compact or use
  // native /compact. Automatic compaction must not retry a failed handoff.
  pi.on('session_compact', async (event, ctx) => {
    // A completed compaction (any path) means usage is being reclaimed: refresh
    // the widget so a stale pre-compaction bar does not linger.
    const state = currentState(ctx);
    persistNotify({ level: 'none', cycle: state?.completedCycles ?? 0 });
    if (!state || !isLockedPhase(state.phase)) exitHard();
    updateWidget(ctx);
    if (!state) return;
    if (state.phase === 'pending' || (state.phase === 'failed' && event.reason === 'manual')) {
      try {
        persist({ ...state, phase: 'ready-to-deliver' });
      } catch {
        // Leave the note locked; a later idle pass will retry reconciliation.
        return;
      }
      // Deliver once the triggering compaction has cleared and the agent is
      // idle, without waiting for another user prompt (spec §3.3). A manual
      // `/compact` emits no agent_settled, so schedule a coordinate pass;
      // agent_settled from an in-progress turn (automatic/self compaction)
      // will also drive delivery, and deliver() is idempotent so only one
      // continuation is ever sent.
      scheduleReconciledDelivery(ctx);
    }
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    disposed = true;
    busy = false;
    lastReservedMessageId = undefined;
    for (const timer of reconcileTimers) clearTimeout(timer);
    reconcileTimers.clear();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
