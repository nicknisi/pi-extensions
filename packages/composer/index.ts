/**
 * Composer: the whole bottom of pi's screen as one configurable system.
 *
 * Owns the input box, the footer, the row above the box, and how pi's
 * working indicator and message look. A style is a preset of slots and
 * options; ~/.pi/agent/configs/composer.json overrides any of it.
 *
 *   above        row above the box (an aboveEditor widget, so it stays during dialogs)
 *   topLeft …    inlays on the box's borders
 *   rightPrompt  right-aligned on the first input line
 *   footerLeft … the footer row
 *
 * Event contracts on pi.events:
 *   composer:set-label { text }      another extension sets the label item (empty clears)
 *   composer:label-request           emitted on session start so producers re-push
 *   composer:context-bar <boolean>   whether a context meter is on screen (checkpoint hides its own)
 *   composer:request-context-bar     ask composer to re-announce the above
 *   self-compact:context-color       consumed: checkpoint's colour for the context meter
 */

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { load, spinnerFrames, STATES, type ComposerConfig, type LoadResult, type StateName } from './config.js';
import { setDataListener, usageHealth } from './data.js';
import { Composer } from './editor.js';
import { disableFocusTracking, enableFocusTracking, paneFocused } from './focus.js';
import { promptWidth, renderAbove, renderFooter, type Ctx } from './render.js';
import { createRuntime, noteTokens, resetRun, type ContextColor, type Runtime } from './state.js';
import { STYLES, type StyleName } from './styles.js';
import { applyColor, parseLabelData } from './utils.js';
import { randomVerb, shimmerFrame } from './verbs.js';

const ABOVE_WIDGET = 'composer-above';

/** Characters streamed so far in an assistant message (text, thinking, tool-call arguments). */
export function streamedChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content as Array<Record<string, unknown>>) {
    if (typeof part.text === 'string') n += part.text.length;
    if (typeof part.thinking === 'string') n += part.thinking.length;
    if (part.arguments !== undefined) n += JSON.stringify(part.arguments).length;
  }
  return n;
}
const CONTEXT_COLORS = new Set(['success', 'accent', 'warning', 'error', 'dim']);

export default function composer(pi: ExtensionAPI) {
  const rt: Runtime = createRuntime();
  let loaded: LoadResult = load();
  /** `/composer style <name>`: lasts until pi exits or `/composer style`. */
  let sessionStyle: StyleName | undefined;
  let animTimer: ReturnType<typeof setInterval> | undefined;
  let shimmerTimer: ReturnType<typeof setInterval> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let agentRunning = false;
  /** A config has been applied before, so an unreadable file can fall back to it. */
  let hasLoaded = false;

  const cfg = (): ComposerConfig => loaded.config;
  // Read the theme every frame: a live theme switch must repaint in the new colours.
  const ctxFor = (): Ctx => {
    rt.paneFocused = paneFocused;
    return { cfg: cfg(), rt, theme: rt.ctx!.ui.theme as Theme };
  };
  const repaint = () => rt.tui?.requestRender();

  /** Whether any slot shows the context meter (checkpoint hides its own widget then). */
  const showsContext = () => Object.values(cfg().slots).some((list) => list.flat().includes('context'));
  const announceContextBar = () => pi.events.emit('composer:context-bar', showsContext());

  // ── Animation: only while something moves. Idle means no timers. ────────

  function tickMs(): number {
    const c = cfg();
    const { frames, intervalMs } = spinnerFrames(c);
    const spins = c.prompt.whenBusy === 'spinner' && frames.length > 1 && promptWidth(c) > 0;
    return Math.min(spins ? intervalMs : 1000, c.box.busyEffect === 'off' ? 1000 : 80);
  }

  function startAnimation(): void {
    stopAnimation();
    animTimer = setInterval(repaint, tickMs());
    animTimer.unref?.();
  }

  function stopAnimation(): void {
    if (animTimer) clearInterval(animTimer);
    animTimer = undefined;
  }

  function beginBusy(): void {
    rt.busy = true;
    rt.busySince = rt.now();
    resetRun(rt);
    startAnimation();
  }

  function endBusy(): void {
    rt.busy = false;
    rt.tool = undefined;
    stopAnimation();
    repaint();
  }

  // ── Working indicator + message (verbs folded in from pi-spinner) ───────

  function applyIndicator(ctx: ExtensionContext): void {
    const c = cfg();
    const { frames, intervalMs } = spinnerFrames(c);
    // One spinner on screen: if the prompt symbol spins, pi's indicator shows only the message.
    const promptSpins = c.prompt.whenBusy === 'spinner' && frames.length > 0 && promptWidth(c) > 0;
    ctx.ui.setWorkingIndicator(
      promptSpins
        ? { frames: [] }
        : { frames: frames.map((f) => applyColor(ctx.ui.theme, c.spinner.color, f)), intervalMs },
    );
  }

  function stopShimmer(): void {
    if (shimmerTimer) clearInterval(shimmerTimer);
    shimmerTimer = undefined;
  }

  function startMessage(ctx: ExtensionContext): void {
    stopShimmer();
    const c = cfg();
    const list = c.working.messages;
    const text =
      list === 'verbs'
        ? `${randomVerb()}...`
        : Array.isArray(list) && list.length
          ? list[Math.floor(Math.random() * list.length)]
          : undefined;
    if (!text) {
      ctx.ui.setWorkingMessage();
      return;
    }
    const base = c.items.working?.color ?? c.working.baseColor;
    if (!c.working.shimmer) {
      ctx.ui.setWorkingMessage(applyColor(ctx.ui.theme, base, text));
      return;
    }
    const frame = () =>
      ctx.ui.setWorkingMessage(
        shimmerFrame(text, ctx.ui.theme, {
          periodMs: c.working.shimmerPeriodMs,
          bandWidth: c.working.bandWidth,
          baseColor: base,
          highlightColor: c.working.highlightColor,
        }),
      );
    frame();
    shimmerTimer = setInterval(frame, 80);
    shimmerTimer.unref?.();
  }

  // ── Toasts (styles with `toasts: true`) ──────────────────────────────────

  function toast(text: string, ms = 5000): void {
    if (!cfg().toasts) return;
    rt.toast = { text, until: rt.now() + ms };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      rt.toast = undefined;
      repaint();
    }, ms);
    toastTimer.unref?.();
    repaint();
  }

  // ── Mounting ─────────────────────────────────────────────────────────────

  function report(ctx: ExtensionContext, result: LoadResult): void {
    for (const error of result.errors) ctx.ui.notify(`composer: ${error}`, 'error');
    for (const warning of result.warnings) ctx.ui.notify(`composer.json: ${warning}`, 'warning');
  }

  function mount(ctx: ExtensionContext): void {
    ctx.ui.setEditorComponent((tui, editorTheme, kb) => {
      rt.tui = tui;
      rt.keybindings = kb as Runtime['keybindings'];
      setDataListener(repaint);
      if (cfg().box.focusColor) enableFocusTracking(tui);
      else disableFocusTracking();
      const editor = new Composer(tui, editorTheme, kb, ctxFor, (indicator) => {
        rt.indicator = indicator;
        repaint();
      });
      editor.onCollapsedPaste = (lines) =>
        toast(
          `${applyColor(ctx.ui.theme, 'success', '✓')} ${applyColor(ctx.ui.theme, 'muted', `pasted ${lines} lines · paste again to expand`)}`,
        );
      rt.editor = editor;
      return editor;
    });
    ctx.ui.setFooter((tui, _theme, footerData) => {
      rt.footerData = footerData;
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        render: (width: number) => renderFooter(ctxFor(), width),
        invalidate() {},
        dispose: unsubscribe,
      };
    });
    ctx.ui.setWidget(
      ABOVE_WIDGET,
      () => ({ render: (width: number) => renderAbove(ctxFor(), width), invalidate() {} }),
      {
        placement: 'aboveEditor',
      },
    );
    applyIndicator(ctx);
    announceContextBar();
  }

  /** Load composer.json; if it can't be read or parsed, keep what we had and say so. */
  function loadKeeping(ctx: ExtensionContext): LoadResult {
    const next = load(sessionStyle);
    report(ctx, next);
    // A session style shows the preset as shipped and never reads composer.json,
    // so only a config that comes from the file is kept back.
    if (next.unreadable && hasLoaded && !sessionStyle) {
      ctx.ui.notify('composer: kept the previous config until composer.json parses again', 'warning');
      return { ...next, kept: true };
    }
    loaded = next;
    hasLoaded = true;
    return next;
  }

  function reload(ctx: ExtensionContext): LoadResult {
    const result = loadKeeping(ctx);
    mount(ctx);
    if (rt.busy) startAnimation();
    repaint();
    return result;
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  pi.events.on('composer:set-label', (data) => {
    rt.labelOverride = parseLabelData(data);
    repaint();
  });
  pi.events.on('composer:request-context-bar', () => {
    if (rt.ctx) announceContextBar();
  });
  pi.events.on('self-compact:context-color', (color) => {
    rt.contextColor = typeof color === 'string' && CONTEXT_COLORS.has(color) ? (color as ContextColor) : undefined;
    repaint();
  });

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    rt.ctx = ctx;
    rt.pi = pi;
    rt.sessionName = pi.getSessionName() || undefined;
    rt.labelOverride = undefined;
    loadKeeping(ctx);
    mount(ctx);
    pi.events.emit('composer:label-request', {});
  });

  pi.on('session_info_changed', async (event, ctx) => {
    if (ctx.mode !== 'tui') return;
    rt.sessionName = event.name || undefined;
    repaint();
  });

  pi.on('agent_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    agentRunning = true;
    cancelPreview();
    beginBusy();
  });

  pi.on('agent_settled', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    agentRunning = false;
    endBusy();
  });

  pi.on('turn_start', async (_event, ctx) => {
    if (ctx.mode === 'tui') startMessage(ctx);
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    stopShimmer();
    ctx.ui.setWorkingMessage();
  });

  pi.on('tool_execution_start', async (event) => {
    rt.toolCalls.add(event.toolCallId);
    rt.tool = { name: event.toolName, detail: '', since: rt.now() };
    repaint();
  });

  pi.on('tool_execution_end', async (event) => {
    rt.toolCalls.delete(event.toolCallId);
    if (rt.toolCalls.size === 0) rt.tool = undefined;
    repaint();
  });

  pi.on('ui_prompt_start', async (event) => {
    rt.prompt = { title: event.title ?? '' };
    repaint();
  });

  pi.on('ui_prompt_end', async () => {
    rt.prompt = undefined;
    repaint();
  });

  // Live tokens: ~4 characters per token of what has actually streamed. Providers
  // may report usage early (or only at the end), so the exact figure is used
  // once the message ends.
  pi.on('message_update', async (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== 'assistant') return;
    noteTokens(rt, rt.tokensDone + Math.ceil(streamedChars(message.content) / 4));
  });

  pi.on('message_end', async (event) => {
    const message = event.message as { role?: string; content?: unknown; usage?: { output?: number } };
    if (message.role !== 'assistant') return;
    noteTokens(rt, rt.tokensDone + (message.usage?.output || Math.ceil(streamedChars(message.content) / 4)));
    rt.tokensDone = rt.tokens;
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    disableFocusTracking();
    cancelPreview();
    stopAnimation();
    stopShimmer();
    if (toastTimer) clearTimeout(toastTimer);
    agentRunning = false;
    rt.busy = false;
    rt.indicator = undefined;
    rt.tui = undefined;
    rt.editor = undefined;
    rt.footerData = undefined;
    setDataListener(undefined);
    pi.events.emit('composer:context-bar', false);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setWidget(ABOVE_WIDGET, undefined);
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWorkingMessage();
  });

  // ── /composer ────────────────────────────────────────────────────────────

  function cancelPreview(): void {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = undefined;
    if (rt.preview) {
      rt.preview = undefined;
      if (!agentRunning) endBusy();
    }
  }

  /** Step through every state so a style can be judged without running an agent. */
  function preview(ctx: ExtensionContext): void {
    if (agentRunning) {
      ctx.ui.notify('composer: preview is unavailable while the agent is running', 'warning');
      return;
    }
    cancelPreview(); // one preview at a time
    const steps: StateName[] = STATES.filter((s) => s !== 'idle');
    let i = 0;
    const step = () => {
      const state = steps[i++];
      if (!state) {
        cancelPreview();
        ctx.ui.notify('composer: preview done', 'info');
        return;
      }
      rt.preview = state;
      const busy = state === 'working' || state === 'tool';
      if (busy && !rt.busy) beginBusy();
      if (!busy && rt.busy) endBusy();
      rt.tool = state === 'tool' ? { name: 'bash', detail: '', since: rt.now() } : undefined;
      if (busy) {
        // Sample numbers so the tokens and tps items have something to show.
        rt.tokens = 1284;
        rt.tps = [12, 40, 66, 84, 79, 81];
      }
      ctx.ui.notify(`composer preview: ${state}`, 'info');
      repaint();
      previewTimer = setTimeout(step, 1600);
      previewTimer.unref?.();
    };
    step();
  }

  const styleNames = Object.keys(STYLES) as StyleName[];

  pi.registerCommand('composer', {
    description: 'Reload composer.json, try a style (/composer style slab), or preview every state',
    getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
      const options = ['style', 'preview', ...styleNames.map((s) => `style ${s}`)];
      return options.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
    },
    handler: async (args, ctx) => {
      const [sub, name] = args.trim().split(/\s+/);
      if (sub === 'preview') {
        preview(ctx);
        return;
      }
      if (sub === 'style') {
        if (name && !styleNames.includes(name as StyleName)) {
          ctx.ui.notify(`composer: no style "${name}". Styles: ${styleNames.join(', ')}`, 'error');
          return;
        }
        const previous = sessionStyle;
        sessionStyle = name as StyleName | undefined;
        if (reload(ctx).kept) {
          // Going back to an unreadable composer.json: stay on what's showing, and say so.
          sessionStyle = previous;
          ctx.ui.notify(
            `composer: composer.json can't be read, so staying on ${previous ? `"${previous}"` : 'the last good config'}`,
            'error',
          );
          return;
        }
        ctx.ui.notify(
          sessionStyle
            ? `composer: trying "${sessionStyle}" as shipped (your overrides are paused). /composer style to go back; set "style" in composer.json to keep it.`
            : 'composer: back to your composer.json',
          'info',
        );
        return;
      }
      if (sub) {
        ctx.ui.notify('composer: usage /composer [style <name> | preview]', 'error');
        return;
      }
      const result = reload(ctx);
      const ok = result.errors.length === 0 && result.warnings.length === 0;
      ctx.ui.notify(
        `composer: style "${cfg().style}"${sessionStyle ? ' (session)' : ''}${ok ? ', config OK' : ''} · usage: ${usageHealth}`,
        'info',
      );
    },
  });
}
