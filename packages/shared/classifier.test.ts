import { describe, expect, it, vi } from 'vitest';
import { type Classifier, classifyBool, findClassifier } from './classifier.js';

const model = (provider: string, id: string) => ({ provider, id }) as Classifier;
const question = { instructions: 'q', criteria: { true: 'yes', false: 'no' } };

describe('findClassifier', () => {
  it('picks the first spec that is available, in spec order', async () => {
    const registry = {
      getAvailableOfType: vi.fn(async () => [
        model('typesafe', 'jev-latest'),
        model('openrouter', 'typesafe/jev-1.14'),
      ]),
    };
    const found = await findClassifier(registry as never, ['openrouter/typesafe/jev-1.14', 'typesafe/jev-latest']);
    expect(found).toEqual(model('openrouter', 'typesafe/jev-1.14'));
  });

  it('degrades to undefined: no match, empty specs, lookup failure, or no classifier API', async () => {
    const available = { getAvailableOfType: async () => [model('typesafe', 'jev-latest')] };
    expect(await findClassifier(available as never, ['opencode/jev-1.13'])).toBeUndefined();
    expect(await findClassifier(available as never, [])).toBeUndefined();
    const failing = { getAvailableOfType: async () => Promise.reject(new Error('auth')) };
    expect(await findClassifier(failing as never, ['typesafe/jev-latest'])).toBeUndefined();
    expect(await findClassifier({}, ['typesafe/jev-latest'])).toBeUndefined();
  });
});

describe('classifyBool', () => {
  const jev = model('typesafe', 'jev-latest');

  it('returns the probability of a successful answer', async () => {
    const registry = {
      classify: async () => ({ stopReason: 'stop', answers: { q: { type: 'bool', probability: 0.8 } } }),
    };
    expect(await classifyBool(registry as never, jev, {}, question)).toBe(0.8);
  });

  it('returns undefined on an error result, a throw, or no classifier API', async () => {
    const errored = { classify: async () => ({ stopReason: 'error', answers: {} }) };
    const throwing = { classify: async () => Promise.reject(new Error('network')) };
    expect(await classifyBool(errored as never, jev, {}, question)).toBeUndefined();
    expect(await classifyBool(throwing as never, jev, {}, question)).toBeUndefined();
    expect(await classifyBool({}, jev, {}, question)).toBeUndefined();
  });
});
