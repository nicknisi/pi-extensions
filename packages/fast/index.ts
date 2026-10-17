import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { childExtensions } from '@nicknisi/pi-shared';
import { loadFastConfig, type FastConfig } from './config.js';
import {
  ANTHROPIC_FAST_SPEED,
  describeFastMode,
  getFastEligibility,
  injectFastPayload,
  isCoolingDown,
  isFastEnabled,
  noteFastError,
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

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
  if (!ctx.hasUI) return;
  if (!state.config.showStatus) {
    ctx.ui.setStatus(EXTENSION_ID, undefined);
    return;
  }

  const eligibility = getFastEligibility(ctx.model, usingOAuth(ctx));
  if (!isFastEnabled(state) || !eligibility.eligible) ctx.ui.setStatus(EXTENSION_ID, undefined);
  else ctx.ui.setStatus(EXTENSION_ID, isCoolingDown(state) ? 'fast (cooldown)' : 'fast');
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
    const cooldown = isCoolingDown(state)
      ? ` Rate limited: standard speed until ${new Date(state.cooldownUntil!).toLocaleTimeString()}.`
      : '';
    return `Fast mode is ${describeFastMode(state)} and active for ${eligibility.modelKey}; requests will use ${wireSetting}.${cooldown}${injected}`;
  }

  if (enabled) {
    return `Fast mode is ${describeFastMode(state)}, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
  }

  return `Fast mode is ${describeFastMode(state)}. Current model: ${eligibility.modelKey}.${injected}`;
}

/**
 * Inject Fast mode into a session's provider requests, and fall back to
 * standard speed after a Fast-mode 429/529 (pi's automatic retry then resends
 * at standard speed). Used for the main session and for subagent children.
 */
function attachRequestHooks(
  target: ExtensionAPI,
  stateFor: (ctx: ExtensionContext) => FastState | undefined,
  hooks: {
    afterRequest?: (ctx: ExtensionContext) => void;
    onCooldown?: (until: number, ctx: ExtensionContext) => void;
  } = {},
): void {
  let lastRequestFast = false;
  target.on('before_provider_request', (event, ctx) => {
    const state = stateFor(ctx);
    if (!state || !ctx.model) return;
    const eligibility = getFastEligibility(ctx.model, usingOAuth(ctx));
    const nextPayload = injectFastPayload(event.payload, ctx.model, eligibility, state);
    lastRequestFast = nextPayload !== undefined;
    hooks.afterRequest?.(ctx);
    return nextPayload;
  });
  target.on('message_end', (event, ctx) => {
    const state = stateFor(ctx);
    const message = event.message;
    if (!state || !lastRequestFast || message.role !== 'assistant' || message.stopReason !== 'error') return;
    const until = noteFastError(state, message.errorMessage ?? '');
    if (until === undefined) return;
    lastRequestFast = false;
    hooks.onCooldown?.(until, ctx);
  });
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

  attachRequestHooks(pi, (ctx) => getState(ctx), {
    afterRequest: (ctx) => updateStatus(ctx, getState(ctx)),
    onCooldown: (until, ctx) => {
      updateStatus(ctx, getState(ctx));
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Fast mode rate limited; using standard speed until ${new Date(until).toLocaleTimeString()}.`,
          'warning',
        );
      }
    },
  });

  // Subagent and workflow children follow this session's /fast state live
  // (and share its rate-limit cooldown).
  const childFactory = (child: ExtensionAPI) => attachRequestHooks(child, () => state);
  pi.on('session_start', () => {
    childExtensions().set(EXTENSION_ID, childFactory);
  });
  pi.on('session_shutdown', () => {
    if (childExtensions().get(EXTENSION_ID) === childFactory) childExtensions().delete(EXTENSION_ID);
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
