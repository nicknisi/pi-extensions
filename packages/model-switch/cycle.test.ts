import { describe, expect, it } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  findActiveSection,
  parseModelReference,
  resolveAvailableModels,
  selectCycleTarget,
  type ModelRegistryLike,
} from './cycle.js';
import type { ModelSwitchSection } from './config.js';

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}

function registry(models: Model<Api>[], unauthenticated: string[] = []): ModelRegistryLike {
  const byReference = new Map(models.map((item) => [`${item.provider}/${item.id}`, item]));
  const unavailable = new Set(unauthenticated);

  return {
    find(provider, modelId) {
      return byReference.get(`${provider}/${modelId}`);
    },
    async getApiKeyAndHeaders(item) {
      const reference = `${item.provider}/${item.id}`;
      return unavailable.has(reference)
        ? { ok: false as const, error: 'not authenticated' }
        : { ok: true as const, apiKey: 'test' };
    },
  };
}

describe('parseModelReference', () => {
  it('keeps slashes inside the model id', () => {
    expect(parseModelReference('fireworks/accounts/fireworks/models/kimi-k3')).toEqual({
      provider: 'fireworks',
      modelId: 'accounts/fireworks/models/kimi-k3',
    });
  });

  it.each(['missing-provider', '/missing-provider', 'missing-model/'])('rejects %s', (value) => {
    expect(parseModelReference(value)).toBeUndefined();
  });
});

describe('resolveAvailableModels', () => {
  it('preserves configured order while skipping invalid, missing, and unauthenticated models', async () => {
    const grok = model('cloudflare-ai-gateway', 'grok-4.5');
    const kimi = model('fireworks', 'accounts/fireworks/models/kimi-k3');
    const deepseek = model('fireworks', 'accounts/fireworks/models/deepseek-v4-pro');

    const result = await resolveAvailableModels(
      [
        'fireworks/accounts/fireworks/models/kimi-k3',
        'invalid',
        'missing/nope',
        'cloudflare-ai-gateway/grok-4.5',
        'fireworks/accounts/fireworks/models/deepseek-v4-pro',
      ],
      registry([grok, kimi, deepseek], ['fireworks/accounts/fireworks/models/deepseek-v4-pro']),
    );

    expect(result).toEqual([kimi, grok]);
  });
});

describe('findActiveSection', () => {
  const workSection: ModelSwitchSection = {
    name: 'work',
    models: ['provider/work-a', 'provider/work-b'],
  };
  const personalSection: ModelSwitchSection = {
    name: 'personal',
    models: ['provider/personal-a'],
  };
  const sections = [workSection, personalSection];

  it('returns undefined for empty sections', () => {
    expect(findActiveSection([], model('provider', 'x'))).toBeUndefined();
  });

  it('returns the first section when there is no current model', () => {
    expect(findActiveSection(sections, undefined)).toBe(workSection);
  });

  it('returns the section containing the current model', () => {
    expect(findActiveSection(sections, model('provider', 'work-b'))).toBe(workSection);
    expect(findActiveSection(sections, model('provider', 'personal-a'))).toBe(personalSection);
  });

  it('falls back to the first section when the current model is not in any section', () => {
    expect(findActiveSection(sections, model('other', 'outside'))).toBe(workSection);
  });
});

describe('selectCycleTarget', () => {
  const first = model('provider', 'first');
  const second = model('provider', 'second');
  const third = model('provider', 'third');
  const available = [first, second, third];

  it('returns undefined for an empty list', () => {
    expect(selectCycleTarget(first, [], 'forward')).toBeUndefined();
  });

  it('returns the only model in either direction', () => {
    expect(selectCycleTarget(first, [first], 'forward')).toBe(first);
    expect(selectCycleTarget(first, [first], 'backward')).toBe(first);
  });

  it('enters at the directional boundary when current is outside the list', () => {
    const outside = model('other', 'outside');

    expect(selectCycleTarget(outside, available, 'forward')).toBe(first);
    expect(selectCycleTarget(outside, available, 'backward')).toBe(third);
    expect(selectCycleTarget(undefined, available, 'forward')).toBe(first);
    expect(selectCycleTarget(undefined, available, 'backward')).toBe(third);
  });

  it('moves in both directions and wraps at each boundary', () => {
    expect(selectCycleTarget(first, available, 'forward')).toBe(second);
    expect(selectCycleTarget(second, available, 'backward')).toBe(first);
    expect(selectCycleTarget(third, available, 'forward')).toBe(first);
    expect(selectCycleTarget(first, available, 'backward')).toBe(third);
  });
});
