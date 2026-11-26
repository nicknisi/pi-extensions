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
  noteFastUnavailable,
  retryAfterMs,
  withFastCost,
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
  it.each(['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-mythos-5-2'])(
    'supports current Anthropic Fast model %s',
    (id) => {
      expect(getFastEligibility(model('anthropic', id, 'anthropic-messages'), false)).toMatchObject({
        eligible: true,
        provider: 'anthropic',
      });
    },
  );

  it.each(['claude-opus-4-6', 'claude-opus-4-7'])('rejects retired Anthropic Fast model %s', (id) => {
    expect(getFastEligibility(model('anthropic', id, 'anthropic-messages'), false).eligible).toBe(false);
  });

  it('requires ChatGPT OAuth for OpenAI Codex', () => {
    const selected = model('openai-codex', 'gpt-5.6-sol', 'openai-codex-responses');
    expect(getFastEligibility(selected, false)).toMatchObject({ eligible: false });
    expect(getFastEligibility(selected, true)).toMatchObject({ eligible: true, provider: 'openai' });
  });

  it.each(['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.2-astra', 'gpt-6.2-sol'])(
    'supports Codex Fast model %s',
    (id) => {
      expect(getFastEligibility(model('openai-codex', id, 'openai-codex-responses'), true).eligible).toBe(true);
    },
  );

  it('rejects GPT-5.5, which Codex retired for ChatGPT sign-in', () => {
    expect(getFastEligibility(model('openai-codex', 'gpt-5.5', 'openai-codex-responses'), true).eligible).toBe(false);
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

  it('injects the priority service tier, which the Codex backend accepts for Fast mode', () => {
    const selected = model('openai-codex', 'gpt-6.2-sol', 'openai-codex-responses');
    const eligibility = getFastEligibility(selected, true);

    expect(injectFastPayload({ model: selected.id }, selected, eligibility, state())).toEqual({
      model: selected.id,
      service_tier: 'priority',
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

describe('withFastCost', () => {
  it('doubles every cost component and keeps token counts', () => {
    const message = {
      role: 'assistant',
      usage: { input: 100, output: 50, cost: { input: 0.4, output: 1, cacheRead: 0.02, cacheWrite: 0.5, total: 1.92 } },
    };
    expect(withFastCost(message)).toEqual({
      role: 'assistant',
      usage: { input: 100, output: 50, cost: { input: 0.8, output: 2, cacheRead: 0.04, cacheWrite: 1, total: 3.84 } },
    });
    expect(message.usage.cost.total).toBe(1.92);
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

  it('stops requesting Fast for a model the plan refuses, and only that model', () => {
    const sol = model('openai-codex', 'gpt-6.2-sol', 'openai-codex-responses');
    const astra = model('openai-codex', 'gpt-6.2-astra', 'openai-codex-responses');
    const current = state();
    const refusal =
      "Codex error: Fast mode isn't available for the selected model in your workspace. Choose Standard speed or another model.";

    expect(noteFastUnavailable(current, '429 rate_limit_error', 'openai-codex/gpt-6.2-sol')).toBe(false);
    expect(noteFastUnavailable(current, refusal, 'openai-codex/gpt-6.2-sol')).toBe(true);
    expect(injectFastPayload({ model: sol.id }, sol, getFastEligibility(sol, true), current)).toBeUndefined();
    expect(injectFastPayload({ model: astra.id }, astra, getFastEligibility(astra, true), current)).toEqual({
      model: astra.id,
      service_tier: 'priority',
    });
  });

  it('lasts as long as the failed response asks when it says', () => {
    const current = state();
    expect(noteFastError(current, '429 {"type":"rate_limit_error"}', 1_000, 7_000)).toBe(8_000);
  });

  it('keeps a longer cooldown that is already running', () => {
    const current = state({ cooldownUntil: 31_000 });
    expect(noteFastError(current, '429 {"type":"rate_limit_error"}', 1_000, 5_000)).toBe(31_000);
  });

  it.each([
    [{ 'retry-after': '12' }, 12_000],
    [{ 'retry-after': '1.5' }, 1_500],
    [{ 'retry-after-ms': '250', 'retry-after': '12' }, 250],
    [{ 'retry-after': new Date(1_000 + 30_000).toUTCString() }, 30_000],
    [{ 'retry-after-ms': '1e309', 'retry-after': '5' }, 5_000],
    [{ 'retry-after': '1e309' }, undefined],
    [{ 'retry-after': '0' }, undefined],
    [{ 'retry-after': 'soon' }, undefined],
    [{}, undefined],
  ])('reads %o as a %s ms wait', (headers, expected) => {
    expect(retryAfterMs(headers, 1_000)).toBe(expected);
  });

  it('ignores other errors', () => {
    const current = state();
    expect(noteFastError(current, '400 {"type":"error","error":{"type":"invalid_request_error"}}')).toBeUndefined();
    expect(current.cooldownUntil).toBeUndefined();
  });
});
