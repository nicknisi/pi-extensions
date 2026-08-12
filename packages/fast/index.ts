import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadFastConfig, type FastConfig } from './config.js';
import {
  ANTHROPIC_FAST_SPEED,
  describeFastMode,
  getFastEligibility,
  injectAnthropicFastHeader,
  injectFastPayload,
  isFastEnabled,
  OPENAI_FAST_SERVICE_TIER,
  type FastState,
} from './fast.js';

const EXTENSION_ID = 'fast';

type SessionState = FastState & {
  config: FastConfig;
};

function createState(ctx: ExtensionContext): SessionState {
  const loaded = loadFastConfig(ctx.cwd, ctx.isProjectTrusted());
  for (const warning of loaded.warnings) {
    if (ctx.hasUI) ctx.ui.notify(warning, 'warning');
    else console.error(`Warning: ${warning}`);
  }

  return {
    config: loaded.config,
    enabledByDefault: loaded.config.enabled,
    override: 'auto',
  };
}

function usingOAuth(ctx: ExtensionContext): boolean {
  return ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
}

async function isAnthropicOAuth(ctx: ExtensionContext): Promise<boolean> {
  try {
    const resolution = await ctx.modelRegistry.getProviderAuth('anthropic');
    if (typeof resolution?.auth.apiKey === 'string') return resolution.auth.apiKey.includes('sk-ant-oat');
  } catch {
    // Fall back to the registry's synchronous credential snapshot.
  }

  return usingOAuth(ctx);
}

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
  if (!ctx.hasUI) return;
  if (!state.config.showStatus) {
    ctx.ui.setStatus(EXTENSION_ID, undefined);
    return;
  }

  const eligibility = getFastEligibility(ctx.model, usingOAuth(ctx));
  ctx.ui.setStatus(EXTENSION_ID, isFastEnabled(state) && eligibility.eligible ? 'fast' : undefined);
}

function getStatusMessage(ctx: ExtensionContext, state: SessionState): string {
  const enabled = isFastEnabled(state);
  const eligibility = getFastEligibility(ctx.model, usingOAuth(ctx));
  const injected = state.lastInjectedAt
    ? ` Last injected for ${state.lastInjectedModel ?? 'unknown model'} ${Math.max(
        0,
        Math.round((Date.now() - state.lastInjectedAt) / 1000),
      )}s ago.`
    : '';

  if (enabled && eligibility.eligible) {
    const wireSetting =
      eligibility.provider === 'anthropic'
        ? `speed=${ANTHROPIC_FAST_SPEED}`
        : `service_tier=${OPENAI_FAST_SERVICE_TIER}`;
    return `Fast mode is ${describeFastMode(state)} and active for ${eligibility.modelKey}; requests will use ${wireSetting}.${injected}`;
  }

  if (enabled) {
    return `Fast mode is ${describeFastMode(state)}, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
  }

  return `Fast mode is ${describeFastMode(state)}. Current model: ${eligibility.modelKey}.${injected}`;
}

export default function fastExtension(pi: ExtensionAPI) {
  let state: SessionState | undefined;

  function getState(ctx: ExtensionContext): SessionState {
    state ??= createState(ctx);
    return state;
  }

  pi.on('session_start', (_event, ctx) => {
    state = createState(ctx);
    updateStatus(ctx, state);
  });

  pi.on('model_select', (_event, ctx) => {
    updateStatus(ctx, getState(ctx));
  });

  pi.on('before_provider_headers', async (event, ctx) => {
    const currentState = getState(ctx);
    if (!isFastEnabled(currentState)) return;

    const eligibility = getFastEligibility(ctx.model, usingOAuth(ctx));
    if (!eligibility.eligible || eligibility.provider !== 'anthropic' || !ctx.model) return;

    injectAnthropicFastHeader(event.headers, {
      modelHeaders: ctx.model.headers,
      compat: ctx.model.compat,
      usingOAuth: await isAnthropicOAuth(ctx),
      hasActiveTools: pi.getActiveTools().length > 0,
    });
  });

  pi.on('before_provider_request', (event, ctx) => {
    const currentState = getState(ctx);
    if (!ctx.model) return;

    const eligibility = getFastEligibility(ctx.model, usingOAuth(ctx));
    const nextPayload = injectFastPayload(event.payload, ctx.model, eligibility, currentState);
    updateStatus(ctx, currentState);
    return nextPayload;
  });

  pi.registerCommand('fast', {
    description: 'Toggle Fast mode for supported Anthropic Claude and OpenAI Codex models',
    handler: async (args, ctx) => {
      const currentState = getState(ctx);
      if (args.trim()) {
        ctx.ui.notify('Usage: /fast', 'warning');
        return;
      }

      currentState.override = isFastEnabled(currentState) ? 'off' : 'on';
      updateStatus(ctx, currentState);
      ctx.ui.notify(getStatusMessage(ctx, currentState), 'info');
    },
  });
}
