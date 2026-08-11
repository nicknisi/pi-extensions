import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelSwitchSection } from './config.js';

export type CycleDirection = 'forward' | 'backward';

export interface ModelReference {
  provider: string;
  modelId: string;
}

export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getApiKeyAndHeaders(
    model: Model<Api>,
  ): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string | null> } | { ok: false; error: string }>;
}

export function parseModelReference(value: string): ModelReference | undefined {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return undefined;

  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

export async function resolveAvailableModels(
  references: readonly string[],
  registry: ModelRegistryLike,
): Promise<Model<Api>[]> {
  const available: Model<Api>[] = [];

  for (const value of references) {
    const reference = parseModelReference(value);
    if (!reference) continue;

    const model = registry.find(reference.provider, reference.modelId);
    if (!model) continue;

    const auth = await registry.getApiKeyAndHeaders(model);
    if (auth.ok) available.push(model);
  }

  return available;
}

export function findActiveSection(
  sections: readonly ModelSwitchSection[],
  current: Model<Api> | undefined,
): ModelSwitchSection | undefined {
  if (sections.length === 0) return undefined;
  if (!current) return sections[0];

  const found = sections.find((section) =>
    section.models.some((value) => {
      const ref = parseModelReference(value);
      return ref?.provider === current.provider && ref?.modelId === current.id;
    }),
  );

  return found ?? sections[0];
}

export function selectCycleTarget(
  current: Model<Api> | undefined,
  available: readonly Model<Api>[],
  direction: CycleDirection,
): Model<Api> | undefined {
  if (available.length === 0) return undefined;

  const currentIndex = current
    ? available.findIndex((model) => model.provider === current.provider && model.id === current.id)
    : -1;

  if (currentIndex === -1) {
    return direction === 'forward' ? available[0] : available[available.length - 1];
  }

  const offset = direction === 'forward' ? 1 : -1;
  const nextIndex = (currentIndex + offset + available.length) % available.length;
  return available[nextIndex];
}
