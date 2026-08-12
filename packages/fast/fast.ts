import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const ANTHROPIC_FAST_BETA = 'fast-mode-2026-02-01';
export const ANTHROPIC_FAST_SPEED = 'fast';
export const OPENAI_FAST_SERVICE_TIER = 'fast';

const ANTHROPIC_PROVIDER_ID = 'anthropic';
const ANTHROPIC_API_ID = 'anthropic-messages';
const ANTHROPIC_SUPPORTED_MODELS = new Set(['claude-opus-4-8', 'claude-opus-5']);
const CLAUDE_CODE_OAUTH_BETAS = ['claude-code-20250219', 'oauth-2025-04-20'];
const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14';
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

const OPENAI_PROVIDER_ID = 'openai-codex';
const OPENAI_API_ID = 'openai-codex-responses';
const OPENAI_SUPPORTED_MODELS = new Set(['gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);

type SelectedModel = NonNullable<ExtensionContext['model']>;
type PayloadRecord = Record<string, unknown>;

export type FastOverride = 'auto' | 'on' | 'off';
export type FastProvider = 'anthropic' | 'openai';

export interface FastState {
  override: FastOverride;
  enabledByDefault: boolean;
  lastInjectedAt?: number;
  lastInjectedModel?: string;
}

export interface FastEligibility {
  eligible: boolean;
  modelKey: string;
  provider?: FastProvider;
  reason?: string;
}

interface AnthropicHeaderCompat {
  forceAdaptiveThinking?: boolean;
  supportsEagerToolInputStreaming?: boolean;
}

interface AnthropicHeaderOptions {
  modelHeaders?: Record<string, string> | undefined;
  compat?: unknown;
  usingOAuth: boolean;
  hasActiveTools: boolean;
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
        reason: 'Anthropic Fast mode currently supports Claude Opus 5 and Claude Opus 4.8',
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
        reason: 'Codex Fast mode currently supports GPT-5.4, GPT-5.5, and GPT-5.6',
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

function splitBetaHeader(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function injectAnthropicFastHeader(
  headers: Record<string, string | null>,
  options: AnthropicHeaderOptions,
): void {
  const matchingHeaderKeys = Object.keys(headers).filter((name) => name.toLowerCase() === 'anthropic-beta');
  const existingBetas = matchingHeaderKeys.flatMap((name) => splitBetaHeader(headers[name]));
  const matchingModelEntries = Object.entries(options.modelHeaders ?? {}).filter(
    ([name]) => name.toLowerCase() === 'anthropic-beta',
  );
  const modelBetas = matchingModelEntries.flatMap(([, value]) => splitBetaHeader(value));
  const providerBetas: string[] = [];
  const compat = options.compat as AnthropicHeaderCompat | undefined;

  if (options.hasActiveTools && compat?.supportsEagerToolInputStreaming === false) {
    providerBetas.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (compat?.forceAdaptiveThinking !== true) {
    providerBetas.push(INTERLEAVED_THINKING_BETA);
  }

  const oauthBetas = options.usingOAuth ? CLAUDE_CODE_OAUTH_BETAS : [];
  const betas = Array.from(
    new Set([...modelBetas, ...existingBetas, ...oauthBetas, ...providerBetas, ANTHROPIC_FAST_BETA]),
  );

  for (const key of matchingHeaderKeys) headers[key] = null;
  headers['anthropic-beta'] = betas.join(',');
}

export function injectFastPayload(
  payload: unknown,
  model: SelectedModel,
  eligibility: FastEligibility,
  state: FastState,
  now = Date.now(),
): PayloadRecord | undefined {
  if (!isFastEnabled(state) || !eligibility.eligible || !eligibility.provider) return undefined;
  if (!isPayloadRecord(payload) || payload.model !== model.id) return undefined;

  if (eligibility.provider === 'anthropic') {
    if ('speed' in payload) return undefined;
    state.lastInjectedAt = now;
    state.lastInjectedModel = eligibility.modelKey;
    return { ...payload, speed: ANTHROPIC_FAST_SPEED };
  }

  if ('service_tier' in payload) return undefined;
  state.lastInjectedAt = now;
  state.lastInjectedModel = eligibility.modelKey;
  return { ...payload, service_tier: OPENAI_FAST_SERVICE_TIER };
}
