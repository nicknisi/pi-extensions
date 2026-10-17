import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const ANTHROPIC_FAST_BETA = 'fast-mode-2026-02-01';
export const ANTHROPIC_FAST_SPEED = 'fast';
export const OPENAI_FAST_SERVICE_TIER = 'fast';

const ANTHROPIC_PROVIDER_ID = 'anthropic';
const ANTHROPIC_API_ID = 'anthropic-messages';
// Opus 5.5 Fast mode is generally available; the older models are a research
// preview that still needs the beta flag.
const ANTHROPIC_SUPPORTED_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']);
const ANTHROPIC_BETA_MODELS = new Set(['claude-opus-5', 'claude-opus-4-8']);
/** Standard-speed cooldown after a Fast-mode 429/529. */
export const DEFAULT_COOLDOWN_MS = 60_000;

const OPENAI_PROVIDER_ID = 'openai-codex';
const OPENAI_API_ID = 'openai-codex-responses';
const OPENAI_SUPPORTED_MODELS = new Set([
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-sol',
]);

type SelectedModel = NonNullable<ExtensionContext['model']>;
type PayloadRecord = Record<string, unknown>;

export type FastOverride = 'auto' | 'on' | 'off';
export type FastProvider = 'anthropic' | 'openai';

export interface FastState {
  override: FastOverride;
  enabledByDefault: boolean;
  lastInjectedAt?: number;
  lastInjectedModel?: string;
  /** Epoch ms until which requests run at standard speed after a Fast-mode rate limit. */
  cooldownUntil?: number;
}

export interface FastEligibility {
  eligible: boolean;
  modelKey: string;
  provider?: FastProvider;
  reason?: string;
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}

export function isFastEnabled(state: FastState): boolean {
  if (state.override === 'on') return true;
  if (state.override === 'off') return false;
  return state.enabledByDefault;
}

export function describeFastMode(state: FastState): string {
  if (state.override === 'on') return 'on (session override)';
  if (state.override === 'off') return 'off (session override)';
  return state.enabledByDefault ? 'on (config default)' : 'off (config default)';
}

export function getFastEligibility(model: ExtensionContext['model'], openAiUsingOAuth: boolean): FastEligibility {
  if (!model) return { eligible: false, modelKey: 'no-model', reason: 'no model is selected' };

  const key = `${model.provider}/${model.id}`;
  if (model.provider === ANTHROPIC_PROVIDER_ID) {
    if (model.api !== ANTHROPIC_API_ID) {
      return {
        eligible: false,
        modelKey: key,
        reason: `current API is ${model.api}, not ${ANTHROPIC_API_ID}`,
      };
    }

    if (!ANTHROPIC_SUPPORTED_MODELS.has(model.id)) {
      return {
        eligible: false,
        modelKey: key,
        reason: 'Anthropic Fast mode currently supports Claude Opus 5.5, Claude Opus 5, and Claude Opus 4.8',
      };
    }

    return { eligible: true, modelKey: key, provider: 'anthropic' };
  }

  if (model.provider === OPENAI_PROVIDER_ID) {
    if (model.api !== OPENAI_API_ID) {
      return {
        eligible: false,
        modelKey: key,
        reason: `current API is ${model.api}, not ${OPENAI_API_ID}`,
      };
    }

    if (!OPENAI_SUPPORTED_MODELS.has(model.id)) {
      return {
        eligible: false,
        modelKey: key,
        reason: 'Codex Fast mode currently supports GPT-5.4 through GPT-5.6 and GPT-6',
      };
    }

    if (!openAiUsingOAuth) {
      return {
        eligible: false,
        modelKey: key,
        reason: 'ChatGPT OAuth is required for Codex Fast mode',
      };
    }

    return { eligible: true, modelKey: key, provider: 'openai' };
  }

  return {
    eligible: false,
    modelKey: key,
    reason: `current provider ${model.provider} is not supported`,
  };
}

export function isCoolingDown(state: FastState, now = Date.now()): boolean {
  return state.cooldownUntil !== undefined && now < state.cooldownUntil;
}

/**
 * Start a standard-speed cooldown after a Fast-mode request is rate limited or
 * over capacity. Provider SDK errors read like `429 {"type":"error",...}`; the
 * retry-after header is not exposed on failed requests, so the cooldown is fixed.
 * Returns the cooldown end, or undefined when the error is something else.
 */
export function noteFastError(state: FastState, errorMessage: string, now = Date.now()): number | undefined {
  if (!/^(429|529)\b|rate_limit_error|overloaded_error/i.test(errorMessage.trim())) return undefined;
  state.cooldownUntil = now + DEFAULT_COOLDOWN_MS;
  return state.cooldownUntil;
}

export function injectFastPayload(
  payload: unknown,
  model: SelectedModel,
  eligibility: FastEligibility,
  state: FastState,
  now = Date.now(),
): PayloadRecord | undefined {
  if (!isFastEnabled(state) || !eligibility.eligible || !eligibility.provider) return undefined;
  if (isCoolingDown(state, now)) return undefined;
  if (!isPayloadRecord(payload) || payload.model !== model.id) return undefined;

  if (eligibility.provider === 'anthropic') {
    if ('speed' in payload) return undefined;
    state.lastInjectedAt = now;
    state.lastInjectedModel = eligibility.modelKey;
    if (!ANTHROPIC_BETA_MODELS.has(model.id)) return { ...payload, speed: ANTHROPIC_FAST_SPEED };
    // pi sends betas in the payload and the SDK turns them into the
    // anthropic-beta header; appending here keeps every beta pi computed.
    const betas = Array.isArray(payload.betas) ? payload.betas : [];
    return { ...payload, speed: ANTHROPIC_FAST_SPEED, betas: [...new Set([...betas, ANTHROPIC_FAST_BETA])] };
  }

  if ('service_tier' in payload) return undefined;
  state.lastInjectedAt = now;
  state.lastInjectedModel = eligibility.modelKey;
  return { ...payload, service_tier: OPENAI_FAST_SERVICE_TIER };
}
