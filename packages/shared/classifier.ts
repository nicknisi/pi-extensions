import type { ClassifierApi, ClassifierBoolQuestion, ClassifierModel, JsonObject } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

export type Classifier = ClassifierModel<ClassifierApi>;

/** TypeSafe's Jev on every provider pi lists it under; the first one with credentials wins. */
export const DEFAULT_CLASSIFIERS: readonly string[] = [
  'typesafe/jev-latest',
  'openrouter/typesafe/jev-1.14',
  'cloudflare-workers-ai/typesafe/jev',
  'vercel-ai-gateway/typesafe-ai/jev',
  'opencode/jev-1.13',
];

/** Partial so callers degrade on pi versions (and test doubles) without classifier support. */
type Registry = Partial<Pick<ModelRegistry, 'getAvailableOfType' | 'classify'>>;

/**
 * The first `provider/model-id` in `specs` that is a classifier with working
 * credentials, or undefined: no match, no credentials, or no classifier API.
 */
export async function findClassifier(registry: Registry, specs: readonly string[]): Promise<Classifier | undefined> {
  if (!specs.length || typeof registry.getAvailableOfType !== 'function') return undefined;
  try {
    const available = await registry.getAvailableOfType('classifier');
    for (const spec of specs) {
      const match = available.find((m) => `${m.provider}/${m.id}` === spec);
      if (match) return match;
    }
  } catch {
    // Credential lookups can fail; treat that as no classifier.
  }
  return undefined;
}

/** Probability that `question` is true of `state`, or undefined when the call fails. Never throws. */
export async function classifyBool(
  registry: Registry,
  model: Classifier,
  state: JsonObject,
  question: Omit<ClassifierBoolQuestion, 'type'>,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (typeof registry.classify !== 'function') return undefined;
  try {
    const result = await registry.classify(
      model,
      { state, questions: { q: { type: 'bool', ...question } } },
      signal ? { signal } : {},
    );
    const answer = result.stopReason === 'stop' ? result.answers.q : undefined;
    return answer?.type === 'bool' ? answer.probability : undefined;
  } catch {
    return undefined;
  }
}
