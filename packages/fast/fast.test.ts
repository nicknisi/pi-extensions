import { describe, expect, it } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  ANTHROPIC_FAST_BETA,
  getFastEligibility,
  injectAnthropicFastHeader,
  injectFastPayload,
  isFastEnabled,
  type FastState,
} from './fast.js';

type SelectedModel = NonNullable<ExtensionContext['model']>;

function model(provider: string, id: string, api: string): SelectedModel {
  return { provider, id, api } as SelectedModel;
}

function state(overrides: Partial<FastState> = {}): FastState {
  return { override: 'auto', enabledByDefault: true, ...overrides };
}

describe('getFastEligibility', () => {
  it.each(['claude-opus-4-8', 'claude-opus-5'])('supports current Anthropic Fast model %s', (id) => {
    expect(getFastEligibility(model('anthropic', id, 'anthropic-messages'), false)).toMatchObject({
      eligible: true,
      provider: 'anthropic',
    });
  });

  it.each(['claude-opus-4-6', 'claude-opus-4-7'])('rejects retired Anthropic Fast model %s', (id) => {
    expect(getFastEligibility(model('anthropic', id, 'anthropic-messages'), false).eligible).toBe(false);
  });

  it('requires ChatGPT OAuth for OpenAI Codex', () => {
    const selected = model('openai-codex', 'gpt-5.6-sol', 'openai-codex-responses');
    expect(getFastEligibility(selected, false)).toMatchObject({ eligible: false });
    expect(getFastEligibility(selected, true)).toMatchObject({ eligible: true, provider: 'openai' });
  });

  it('rejects unsupported APIs and model IDs', () => {
    expect(getFastEligibility(model('anthropic', 'claude-opus-5', 'openai-responses'), false).eligible).toBe(false);
    expect(getFastEligibility(model('openai-codex', 'gpt-5.4', 'openai-responses'), true).eligible).toBe(false);
    expect(getFastEligibility(model('openai-codex', 'gpt-5.4-mini', 'openai-codex-responses'), true).eligible).toBe(
      false,
    );
  });
});

describe('injectAnthropicFastHeader', () => {
  it('merges Fast mode with existing, model, OAuth, and provider betas', () => {
    const headers: Record<string, string | null> = {
      'Anthropic-Beta': 'existing-beta, oauth-2025-04-20',
      'anthropic-beta': 'second-beta',
    };

    injectAnthropicFastHeader(headers, {
      modelHeaders: { 'ANTHROPIC-BETA': 'model-beta' },
      compat: { forceAdaptiveThinking: false, supportsEagerToolInputStreaming: false },
      usingOAuth: true,
      hasActiveTools: true,
    });

    expect(headers['Anthropic-Beta']).toBeNull();
    expect(headers['anthropic-beta']?.split(',')).toEqual([
      'model-beta',
      'existing-beta',
      'oauth-2025-04-20',
      'second-beta',
      'claude-code-20250219',
      'fine-grained-tool-streaming-2025-05-14',
      'interleaved-thinking-2025-05-14',
      ANTHROPIC_FAST_BETA,
    ]);
  });

  it('does not add provider betas that the model does not need', () => {
    const headers: Record<string, string | null> = {};
    injectAnthropicFastHeader(headers, {
      compat: { forceAdaptiveThinking: true, supportsEagerToolInputStreaming: true },
      usingOAuth: false,
      hasActiveTools: true,
    });

    expect(headers['anthropic-beta']).toBe(ANTHROPIC_FAST_BETA);
  });
});

describe('injectFastPayload', () => {
  it('injects Anthropic speed and records the injection', () => {
    const selected = model('anthropic', 'claude-opus-5', 'anthropic-messages');
    const eligibility = getFastEligibility(selected, false);
    const current = state();

    expect(injectFastPayload({ model: selected.id, messages: [] }, selected, eligibility, current, 123)).toEqual({
      model: selected.id,
      messages: [],
      speed: 'fast',
    });
    expect(current).toMatchObject({ lastInjectedAt: 123, lastInjectedModel: 'anthropic/claude-opus-5' });
  });

  it('injects the Codex Fast service tier', () => {
    const selected = model('openai-codex', 'gpt-5.5', 'openai-codex-responses');
    const eligibility = getFastEligibility(selected, true);

    expect(injectFastPayload({ model: selected.id }, selected, eligibility, state())).toEqual({
      model: selected.id,
      service_tier: 'fast',
    });
  });

  it('preserves explicit provider settings', () => {
    const anthropic = model('anthropic', 'claude-opus-5', 'anthropic-messages');
    const openai = model('openai-codex', 'gpt-5.4', 'openai-codex-responses');

    expect(
      injectFastPayload(
        { model: anthropic.id, speed: 'standard' },
        anthropic,
        getFastEligibility(anthropic, false),
        state(),
      ),
    ).toBeUndefined();
    expect(
      injectFastPayload(
        { model: openai.id, service_tier: 'default' },
        openai,
        getFastEligibility(openai, true),
        state(),
      ),
    ).toBeUndefined();
  });

  it('does nothing when disabled or when the payload model differs', () => {
    const selected = model('anthropic', 'claude-opus-5', 'anthropic-messages');
    const eligibility = getFastEligibility(selected, false);

    expect(
      injectFastPayload({ model: selected.id }, selected, eligibility, state({ override: 'off' })),
    ).toBeUndefined();
    expect(injectFastPayload({ model: 'other' }, selected, eligibility, state())).toBeUndefined();
    expect(isFastEnabled(state({ override: 'off' }))).toBe(false);
  });
});
