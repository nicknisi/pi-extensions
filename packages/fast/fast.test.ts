import { describe, expect, it } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  ANTHROPIC_FAST_BETA,
  DEFAULT_COOLDOWN_MS,
  getFastEligibility,
  injectFastPayload,
  isCoolingDown,
  isFastEnabled,
  noteFastError,
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
  it.each(['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'])('supports current Anthropic Fast model %s', (id) => {
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

  it.each(['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'])('supports Codex Fast model %s', (id) => {
    expect(getFastEligibility(model('openai-codex', id, 'openai-codex-responses'), true).eligible).toBe(true);
  });

  it('rejects unsupported APIs and model IDs', () => {
    expect(getFastEligibility(model('anthropic', 'claude-opus-5', 'openai-responses'), false).eligible).toBe(false);
    expect(getFastEligibility(model('openai-codex', 'gpt-5.4', 'openai-responses'), true).eligible).toBe(false);
    expect(getFastEligibility(model('openai-codex', 'gpt-5.4-mini', 'openai-codex-responses'), true).eligible).toBe(
      false,
    );
  });
});

describe('injectFastPayload', () => {
  it('injects Anthropic speed without a beta for generally available Opus 5.5', () => {
    const selected = model('anthropic', 'claude-opus-5-5', 'anthropic-messages');
    const current = state();

    expect(
      injectFastPayload(
        { model: selected.id, messages: [], betas: ['mid-conversation-output-config-2026-07-01'] },
        selected,
        getFastEligibility(selected, false),
        current,
        123,
      ),
    ).toEqual({
      model: selected.id,
      messages: [],
      betas: ['mid-conversation-output-config-2026-07-01'],
      speed: 'fast',
    });
    expect(current).toMatchObject({ lastInjectedAt: 123, lastInjectedModel: 'anthropic/claude-opus-5-5' });
  });

  it('appends the preview beta to the betas pi computed instead of replacing them', () => {
    const selected = model('anthropic', 'claude-opus-5', 'anthropic-messages');
    const piBetas = ['oauth-2025-04-20', 'mid-conversation-output-config-2026-07-01', ANTHROPIC_FAST_BETA];

    expect(
      injectFastPayload({ model: selected.id, betas: piBetas }, selected, getFastEligibility(selected, false), state()),
    ).toEqual({ model: selected.id, betas: piBetas, speed: 'fast' });
    expect(injectFastPayload({ model: selected.id }, selected, getFastEligibility(selected, false), state())).toEqual({
      model: selected.id,
      betas: [ANTHROPIC_FAST_BETA],
      speed: 'fast',
    });
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

describe('rate-limit cooldown', () => {
  it.each([
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Fast mode rate limit"}}',
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  ])('falls back to standard speed after %s', (message) => {
    const selected = model('anthropic', 'claude-opus-5-5', 'anthropic-messages');
    const eligibility = getFastEligibility(selected, false);
    const current = state();

    expect(noteFastError(current, message, 1_000)).toBe(1_000 + DEFAULT_COOLDOWN_MS);
    expect(isCoolingDown(current, 1_001)).toBe(true);
    expect(injectFastPayload({ model: selected.id }, selected, eligibility, current, 1_001)).toBeUndefined();
    expect(
      injectFastPayload({ model: selected.id }, selected, eligibility, current, 1_000 + DEFAULT_COOLDOWN_MS),
    ).toEqual({ model: selected.id, speed: 'fast' });
  });

  it('ignores other errors', () => {
    const current = state();
    expect(noteFastError(current, '400 {"type":"error","error":{"type":"invalid_request_error"}}')).toBeUndefined();
    expect(current.cooldownUntil).toBeUndefined();
  });
});
