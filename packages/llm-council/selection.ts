import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ResolvedCouncil } from './config.js';

export const SELECTION_ENTRY = 'llm-council-selection';
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface CouncilSelection {
  models: string[];
  chairman: string;
  memberThinking: string | null;
  chairmanThinking: string | null;
}

export function selectionFromCouncil(council: ResolvedCouncil): CouncilSelection {
  return {
    models: council.member.council.map((member) => member.model),
    chairman: council.chairman.model,
    memberThinking: council.member.thinking,
    chairmanThinking: council.chairman.thinking,
  };
}

export function restoreSelection(ctx: ExtensionContext): CouncilSelection | undefined {
  let selection: CouncilSelection | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== SELECTION_ENTRY) continue;
    const data = entry.data as CouncilSelection | null | undefined;
    if (data === null) selection = undefined;
    else if (
      data &&
      Array.isArray(data.models) &&
      data.models.length > 0 &&
      data.models.every((model) => typeof model === 'string' && model.trim()) &&
      typeof data.chairman === 'string' &&
      data.chairman.trim() &&
      [data.memberThinking, data.chairmanThinking].every((level) => level === null || THINKING_LEVELS.includes(level))
    )
      selection = data;
  }
  return selection;
}

/** A bare ID and its provider-qualified form identify the same configured persona. */
export function sameModelReference(configured: string, selected: string): boolean {
  return configured === selected || configured === selected.slice(selected.indexOf('/') + 1);
}

export function applySelection(council: ResolvedCouncil, selection: Partial<CouncilSelection>): ResolvedCouncil {
  return {
    member: {
      ...council.member,
      thinking: selection.memberThinking !== undefined ? selection.memberThinking : council.member.thinking,
      council:
        selection.models?.map((model, index) => {
          const existing = council.member.council.find((member) => sameModelReference(member.model, model));
          return {
            label: `Member ${index + 1}`,
            systemPrompt: council.member.defaultSystemPrompt,
            ...existing,
            model,
          };
        }) ?? council.member.council,
    },
    chairman: {
      ...council.chairman,
      ...(selection.chairman !== undefined && selection.chairman !== council.chairman.model
        ? {
            model: selection.chairman,
            displayName: sameModelReference(council.chairman.model, selection.chairman)
              ? council.chairman.displayName
              : undefined,
          }
        : {}),
      thinking: selection.chairmanThinking !== undefined ? selection.chairmanThinking : council.chairman.thinking,
    },
  };
}

/** Resolve human shorthand without silently choosing a provider or a newer version. */
export async function resolveCouncilModel(
  reference: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const models = ctx.modelRegistry.getAvailable();
  const key = (model: (typeof models)[number]) => `${model.provider}/${model.id}`;
  const query = reference.trim().toLowerCase();
  if (!/[a-z0-9]/.test(query))
    throw new Error('Council model must contain a model name. Use /council settings to choose a model.');
  const qualified = reference.includes('/');
  const exact = models.filter(
    (model) => key(model).toLowerCase() === query || (!qualified && model.id.toLowerCase() === query),
  );
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches =
    exact.length || qualified
      ? exact
      : models.filter(
          (model) =>
            normalize(key(model)).includes(normalize(query)) || normalize(model.name ?? '').includes(normalize(query)),
        );
  if (!matches.length)
    throw new Error(
      `No available council model matches "${reference}". Use /council settings or configure its provider with /login.`,
    );
  if (matches.length === 1) return key(matches[0]!);
  const choices = matches.map(key);
  if (!ctx.hasUI) throw new Error(`Ambiguous council model "${reference}". Specify one of: ${choices.join(', ')}`);
  const selected = await ctx.ui.select(
    `Choose council model for "${reference}"`,
    choices,
    signal ? { signal } : undefined,
  );
  signal?.throwIfAborted();
  if (!selected) throw new Error('Council model selection cancelled. No council was started.');
  return selected;
}

export async function resolveOverrides(
  overrides: { models?: string[] | undefined; chairman?: string | undefined },
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Partial<CouncilSelection>> {
  const result: Partial<CouncilSelection> = {};
  if (overrides.models !== undefined) {
    if (!overrides.models.length) throw new Error('Select at least one council member in /council settings.');
    result.models = [];
    // Resolve sequentially so ambiguous references cannot open competing dialogs.
    for (const model of overrides.models) result.models.push(await resolveCouncilModel(model, ctx, signal));
    if (new Set(result.models).size !== result.models.length)
      throw new Error('Council members must be distinct models.');
  }
  if (overrides.chairman !== undefined) result.chairman = await resolveCouncilModel(overrides.chairman, ctx, signal);
  return result;
}

export function updateCouncilStatus(ctx: ExtensionContext, council: ResolvedCouncil, selected: boolean): void {
  const available = ctx.modelRegistry.getAvailable();
  const name = (reference: string) =>
    available.find((model) => `${model.provider}/${model.id}` === reference)?.name ?? reference;
  const names = council.member.council.map((member) => member.displayName ?? name(member.model));
  ctx.ui.setStatus(
    'llm-council',
    selected
      ? `Council: ${names.join(' + ')} · chair: ${council.chairman.displayName ?? name(council.chairman.model)}`
      : undefined,
  );
}
