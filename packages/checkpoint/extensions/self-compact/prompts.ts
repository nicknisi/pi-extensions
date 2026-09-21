/**
 * Summary system-message replacement for self-compaction.
 *
 * Pi 0.86 carries the compaction summary instruction as the leading system
 * message of the normalized transcript context. We reuse Pi's exported
 * `compact()` (its split-turn, file-tracking, previous-summary, and usage
 * accounting logic) and only rewrite that leading system message through the
 * stream callback, so the actual request the provider sees uses our
 * instruction instead of Pi's default summarizer prompt.
 *
 * Failure is never silent: an empty, truncated, errored, or aborted summary is
 * reported as an error so the caller can cancel compaction and keep the handoff
 * locked, rather than falling back to Pi's default compactor.
 */
import { buildSessionProjection, compact, findCutPoint, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { CompactionResult } from '@earendil-works/pi-coding-agent';
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Check the edited, retained context using Pi's cut-point rules, without persisting or locking. */
export function hasCompactionMaterial(branch: SessionEntry[], keepRecentTokens: number): boolean {
  if (branch.at(-1)?.type === 'compaction') return false;
  const entries: SessionEntry[] = buildSessionProjection(branch).entries.flatMap(({ sourceEntry, messages }) =>
    messages
      .filter((message) => message.role !== 'system' && message.role !== 'compactionSummary')
      .map((message) => ({ ...sourceEntry, type: 'message' as const, message })),
  );
  return findCutPoint(entries, 0, entries.length, keepRecentTokens).firstKeptEntryIndex > 0;
}

/** Name of the editable default summary instruction file, under `.pi/self-compact/`. */
export const COMPACTION_MESSAGE_FILE = 'USER_PROMPT_COMPACTION_MESSAGE.md';

/** Editable soft heads-up guidance template. */
export const SOFT_SELF_COMPACT_FILE = 'USER_PROMPT_SOFT_SELF_COMPACT.md';

/** Editable stern warning guidance template. */
export const WARNING_SELF_COMPACT_FILE = 'USER_PROMPT_WARNING_SELF_COMPACT.md';

export type GuidanceLevel = 'soft' | 'warning';

/** Interpolation vocabulary shared by the soft/warning guidance templates. */
export interface GuidanceValues {
  tokens: number;
  percent: number;
  context_window: number;
  soft_tokens: number;
  warning_tokens: number;
  hard_tokens: number;
  hard_percent: number;
}

/** Replace `{{token}}` placeholders with the supplied values; unknown tokens are left intact. */
export function interpolateGuidance(template: string, values: GuidanceValues): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return String(values[key as keyof GuidanceValues]);
    }
    return match;
  });
}

/** Read an editable guidance template, per use (no caching). */
export function loadGuidanceTemplate(level: GuidanceLevel, fromDir?: string): string {
  const fileName = level === 'soft' ? SOFT_SELF_COMPACT_FILE : WARNING_SELF_COMPACT_FILE;
  const file = path.join(packageResourceDir(fromDir), fileName);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`self-compact: cannot read guidance template ${fileName}: ${message}`);
  }
}

/** Load and interpolate a guidance template for delivery. */
export function renderGuidance(
  level: GuidanceLevel,
  values: GuidanceValues,
  loadTemplate: (level: GuidanceLevel) => string = (l) => loadGuidanceTemplate(l),
): string {
  return interpolateGuidance(loadTemplate(level), values);
}

/** The `compact()` preparation payload, as delivered by `session_before_compact`. */
export type CompactionPreparation = Parameters<typeof compact>[0];

/** A stream callback compatible with `compact()`'s `streamFn` parameter. */
export type SummaryStreamFn = NonNullable<Parameters<typeof compact>[7]>;

/** Minimal shape of `ctx.modelRegistry.streamSimple` we depend on. */
export type StreamSimpleFn = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Resolve the package-relative `.pi/self-compact/` directory independent of the
 * launch cwd. Walk up from this module until the directory is found so the same
 * lookup works from raw sources (jiti) and from emitted `dist/` output.
 */
export function packageResourceDir(fromDir?: string): string {
  let dir = fromDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.pi', 'self-compact');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the conventional location relative to this module.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.pi', 'self-compact');
}

/** Read the editable default summary instruction, per use (no caching). */
export function loadDefaultCompactionInstruction(fromDir?: string): string {
  const file = path.join(packageResourceDir(fromDir), COMPACTION_MESSAGE_FILE);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Resolve the summary system instruction. A literal `--compact-prompt` override
 * (added in phase 2) always wins over the editable default file; both are
 * independent of the saved handoff note, which is delivered separately.
 */
export function resolveCompactionInstruction(options: {
  compactPromptOverride?: string | undefined;
  loadDefault?: (() => string) | undefined;
}): string {
  const override = options.compactPromptOverride;
  if (typeof override === 'string' && override.trim().length > 0) return override;
  const load = options.loadDefault ?? (() => loadDefaultCompactionInstruction());
  return load();
}

/** Replace (or insert) the leading system message of a normalized transcript. */
export function applyLeadingSystemInstruction(context: TranscriptContext, instruction: string): TranscriptContext {
  const messages = context.messages;
  const first = messages[0];
  if (first && first.role === 'system') {
    first.content = instruction;
  } else {
    messages.unshift({ role: 'system', content: instruction, timestamp: Date.now() });
  }
  return context;
}

/** Extract the leading system instruction text from a normalized transcript. */
export function leadingSystemInstruction(context: TranscriptContext): string | undefined {
  const first = context.messages[0];
  if (!first || first.role !== 'system') return undefined;
  if (typeof first.content === 'string') return first.content;
  return first.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/** Build the `compact()` stream callback that overrides the summary instruction. */
export function buildSummaryStreamFn(instruction: string, streamSimple: StreamSimpleFn): SummaryStreamFn {
  return (model, context, options) => {
    applyLeadingSystemInstruction(context, instruction);
    return streamSimple(model as Model<string>, context as unknown as Context, options);
  };
}

export interface RunSelfCompactionOptions {
  preparation: CompactionPreparation;
  model: Model<string>;
  streamSimple: StreamSimpleFn;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  env?: Record<string, string> | undefined;
  customInstructions?: string | undefined;
  signal?: AbortSignal | undefined;
  compactPromptOverride?: string | undefined;
  loadDefault?: () => string;
}

/**
 * Run compaction with the overridden summary instruction. Throws on any
 * failure (empty/truncated summary, provider error, or abort) so the caller
 * records the failure and cancels — never silently reverting to the default.
 */
export async function runSelfCompaction(options: RunSelfCompactionOptions): Promise<CompactionResult> {
  const instruction = resolveCompactionInstruction({
    compactPromptOverride: options.compactPromptOverride,
    loadDefault: options.loadDefault,
  });
  const streamFn = buildSummaryStreamFn(instruction, options.streamSimple);

  const result = await compact(
    options.preparation,
    options.model,
    options.apiKey,
    options.headers,
    options.customInstructions,
    options.signal,
    undefined,
    streamFn,
    options.env,
  );

  if (options.signal?.aborted) {
    throw new Error('self-compact: summarization aborted before completion');
  }
  if (typeof result.summary !== 'string' || result.summary.trim().length === 0) {
    throw new Error('self-compact: summarization produced an empty summary');
  }
  return result;
}
