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
  type ExtensionContext,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { loadDefaultCompactionInstruction, runSelfCompaction } from './prompts.js';

export const TOOL_NAME = 'self_compact';
export const STATE_ENTRY = 'self-compact:state';
export const DELIVERY_ENTRY = 'self-compact:delivered';
export const CONTINUATION_MESSAGE_TYPE = 'self-compact:continuation';
export const MAX_NOTE_LENGTH = 24000;

/**
 * Safety cap for how long `agent_settled` blocks awaiting a continuation turn.
 * In normal operation the continuation settles in milliseconds; the cap only
 * prevents a pathological hang from wedging the handler forever.
 */
export const CONTINUATION_IDLE_TIMEOUT_MS = 30000;

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
  // Timers scheduling a post-reconciliation delivery, cleared on shutdown so a
  // late callback cannot touch a replaced session.
  const reconcileTimers = new Set<ReturnType<typeof setTimeout>>();

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

    const active = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
    const state: HandoffState = {
      cycleId: uuidv7(),
      phase: 'pending',
      note: validation.note,
      originalActiveTools: active,
      completedCycles: existing?.completedCycles ?? 0,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    persist(state);
    lockTools();
    return validation;
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
  }

  /**
   * Wait until the just-triggered continuation turn settles. The continuation
   * runs as a detached turn (`sendMessage` returns no promise), so poll the
   * public idle check rather than awaiting an internal promise. Never awaits
   * `waitForIdle` (unavailable on the settled ctx and prone to deadlock).
   */
  async function waitForContinuationIdle(ctx: ExtensionContext): Promise<void> {
    const deadline = Date.now() + CONTINUATION_IDLE_TIMEOUT_MS;
    while (!disposed && Date.now() < deadline) {
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
    return undefined;
  });

  pi.on('session_start', async (_event, ctx) => {
    disposed = false;
    busy = false;
    lastReservedMessageId = undefined;
    sessionId = ctx.sessionManager.getSessionId();

    const state = currentState(ctx);
    if (!state) return;
    if (isLockedPhase(state.phase)) {
      lockTools();
    }
    // ready-to-deliver / pending resume once the agent is idle (agent_settled).
  });

  pi.on('agent_settled', async (_event, ctx) => {
    await coordinate(ctx);
  });

  // Replace the summary system instruction for every compaction path (our own,
  // manual /compact, and Pi's automatic threshold/overflow). Failure cancels
  // rather than silently reverting to Pi's default compactor.
  pi.on('session_before_compact', async (event, ctx) => {
    const model = ctx.model;
    if (!model) return { cancel: true };

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`self-compact: cannot compact without provider auth: ${auth.error}`, 'error');
      return { cancel: true };
    }

    const headers: Record<string, string> | undefined = auth.headers
      ? Object.fromEntries(
          Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : undefined;

    try {
      const result = await runSelfCompaction({
        preparation: event.preparation,
        model,
        streamSimple: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
        apiKey: auth.apiKey,
        headers,
        env: auth.env,
        customInstructions: event.customInstructions,
        signal: event.signal,
        loadDefault: () => loadDefaultCompactionInstruction(),
      });
      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
        },
      };
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
  // Scoped to the 'pending' phase only: a 'failed' cycle stays locked and
  // requires explicit retry (spec §5), so an unrelated successful compaction
  // must not silently discharge it and bypass that gate. 'compacting' is our
  // own in-flight cycle (delivered by compactThenDeliver, not here).
  pi.on('session_compact', async (_event, ctx) => {
    const state = currentState(ctx);
    if (!state) return;
    if (state.phase === 'pending') {
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

  pi.on('session_shutdown', async (_event, _ctx) => {
    disposed = true;
    busy = false;
    lastReservedMessageId = undefined;
    for (const timer of reconcileTimers) clearTimeout(timer);
    reconcileTimers.clear();
  });
}
