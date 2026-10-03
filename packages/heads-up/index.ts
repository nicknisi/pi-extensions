/**
 * heads-up — a side agent that flags, above the editor, things you might miss
 * during long tasks. Port of the Claude Code "heads-up" mod (itself a fork of
 * the built-in "You should know" mod).
 *
 * After a long run (minTools tool calls or minSeconds), a side model reads a
 * digest of the session and answers with at most one short note, or nothing.
 * The note shows as a widget above the editor; the shortcut (default alt+h)
 * opens an action panel in place of the editor.
 */

import { uuidv7 } from '@earendil-works/pi-ai';
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Key,
  Markdown,
  matchesKey,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {
  type Kind,
  loadConfig,
  logEvent,
  MAX_EVENTS,
  MAX_KNOWN,
  MAX_OFFERED,
  parseModelSpec,
  pushFront,
  readStore,
  updateStore,
} from './config.js';
import { card, innerWidth } from './card.js';
import { type Note, parse, type Tag } from './parse.js';
import {
  chatPrompt,
  checkPrompt,
  checkSystem,
  digest,
  pagePrompt,
  type Variant,
  variantPrompt,
  variantSystem,
} from './prompt.js';

const WIDGET_KEY = 'heads-up';
const TICK_MS = 10_000;

export type View = 'collapsed' | 'expanded' | 'working';

type PanelAction = 'close' | 'page' | 'chat' | 'known' | 'dismissed';

/** The note on screen, its panel view, the latest rewrite, and when it arrived. */
type Shown = { note: Note; view: View; rewrite: string | null; at: number };

/** Each tag gets its own color and glyph: amber flag for this session's work, accent star for background knowledge. */
const TAG_STYLE: Record<Tag, { color: 'warning' | 'accent'; glyph: string }> = {
  'Heads up': { color: 'warning', glyph: '⚑' },
  'You should know': { color: 'accent', glyph: '✦' },
};

const tagTitle = (theme: Theme, tag: Tag): string => {
  const { color, glyph } = TAG_STYLE[tag];
  return theme.fg(color, theme.bold(`${glyph} ${tag}`));
};

const painter =
  (theme: Theme, tag: Tag) =>
  (s: string): string =>
    theme.fg(TAG_STYLE[tag].color, s);

const age = (at: number): string => {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
};

/**
 * Key chips: the key on a highlighted cell in the tag color, then a muted
 * label. Packed greedily into rows so a chip never splits from its label.
 */
const chips = (theme: Theme, tag: Tag, pairs: [string, string][], width: number): string[] => {
  const rows: string[] = [];
  let row = '';
  for (const [key, label] of pairs) {
    const chip = `${theme.bg('selectedBg', theme.fg(TAG_STYLE[tag].color, theme.bold(` ${key} `)))} ${theme.fg('muted', label)}`;
    const joined = row ? `${row}   ${chip}` : chip;
    if (row && visibleWidth(joined) > width) {
      rows.push(row);
      row = chip;
    } else row = joined;
  }
  if (row) rows.push(row);
  return rows;
};

/** Collapsed band above the editor. Not focusable: the shortcut opens the panel. */
class Band implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly note: Note,
    private readonly shortcut: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { theme, note } = this;
    return card(width, painter(theme, note.tag), {
      title: tagTitle(theme, note.tag),
      right: theme.fg('accent', `${this.shortcut} to open`),
      sections: [wrapTextWithAnsi(note.learn, innerWidth(width))],
      bottom: theme.fg('dim', 'learn more · make a page · knew this · dismiss'),
    });
  }
}

/** Interactive panel shown in place of the editor while the note has focus. */
export class Panel implements Component {
  private disposed = false;
  private abort: AbortController | undefined;

  constructor(
    private readonly tui: Pick<TUI, 'requestRender'>,
    private readonly theme: Theme,
    private readonly state: Shown,
    private readonly rewrite: (variant: Variant, signal: AbortSignal) => Promise<string | null>,
    private readonly onExplain: () => void,
    private readonly done: (action: PanelAction) => void,
  ) {
    if (state.view === 'working') state.view = 'expanded';
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
  }

  invalidate(): void {}

  private finish(action: PanelAction): void {
    this.abort?.abort();
    this.done(action);
  }

  private explain(variant: Variant): void {
    this.state.view = 'working';
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.tui.requestRender();
    void this.rewrite(variant, signal)
      .then((text) => {
        if (text) this.state.rewrite = text;
      })
      .catch(() => {})
      .finally(() => {
        // A newer rewrite owns the view now.
        if (this.abort?.signal !== signal) return;
        this.state.view = 'expanded';
        if (!this.disposed) this.tui.requestRender();
      });
  }

  handleInput(data: string): void {
    const { view } = this.state;
    if (matchesKey(data, Key.escape)) {
      if (view === 'working') {
        this.abort?.abort();
        return;
      }
      this.finish('close');
      return;
    }
    if (data === '2') return this.finish('page');
    if (data === '3') return this.finish('known');
    if (data === '0') return this.finish('dismissed');
    if (view === 'collapsed') {
      if (data === '1') {
        this.state.view = 'expanded';
        this.onExplain();
        this.tui.requestRender();
      }
      return;
    }
    if (view === 'working') return;
    if (data === 's') this.explain('simpler');
    else if (data === 'l') this.explain('less');
    else if (data === 'm') this.explain('more');
    else if (data === 'c') this.finish('chat');
  }

  render(width: number): string[] {
    const { theme, state } = this;
    const { note, view } = state;
    const inner = innerWidth(width);
    const back: [string, string] = ['esc', view === 'working' ? 'cancel' : 'back'];
    const frame = (sections: string[][]) =>
      card(width, painter(theme, note.tag), {
        title: tagTitle(theme, note.tag),
        right: theme.fg('dim', age(state.at)),
        sections,
      });
    const keys = (pairs: [string, string][]) => chips(theme, note.tag, pairs, inner);

    if (view === 'collapsed') {
      return frame([
        wrapTextWithAnsi(note.learn, inner),
        keys([['1', 'learn more'], ['2', 'make a page'], ['3', 'knew this'], ['0', 'dismiss'], back]),
      ]);
    }

    const body =
      view === 'working'
        ? [theme.fg('dim', 'Rewriting…')]
        : new Markdown(state.rewrite ?? `**${note.title}**\n\n${note.body}`, 0, 0, getMarkdownTheme()).render(inner);
    return frame([
      ['', ...body, ''],
      keys([
        ['s', 'simpler'],
        ['l', 'shorter'],
        ['m', 'more detail'],
        ['c', 'ask in chat'],
        ['2', 'make a page'],
        ['3', 'knew this'],
        ['0', 'dismiss'],
        back,
      ]),
    ]);
  }
}

export default function headsUp(pi: ExtensionAPI) {
  const { config, warnings } = loadConfig();
  const minMs = config.minSeconds * 1000;
  const cooldownMs = config.cooldownSeconds * 1000;

  // The note on screen, its panel view, and the latest rewrite. In memory: a
  // note never outlives the pi process.
  let shown: Shown | null = null;
  let panelOpen = false;

  const turn = { running: false, startedAt: 0, tools: 0 };
  let checkWanted = false;
  let lastCheckAt = -Infinity;
  let checking = false;
  let warnedError = false;
  let warnedModel = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inflight: AbortController | undefined;

  const isLong = (now: number) => turn.tools >= config.minTools || now - turn.startedAt >= minMs;

  const renderBand = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    const note = shown?.note;
    if (!note || panelOpen) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new Band(theme, note, config.shortcut), {
      placement: 'aboveEditor',
    });
  };

  const clearNote = (ctx: ExtensionContext, kind?: Kind) => {
    const note = shown?.note;
    shown = null;
    renderBand(ctx);
    if (note && kind) logEvent(kind, note.learn);
  };

  const resolveModel = (ctx: ExtensionContext) => {
    const spec = config.model ? parseModelSpec(config.model) : undefined;
    const configured = spec ? ctx.modelRegistry.find(spec.provider, spec.id) : undefined;
    if (config.model && !configured && !warnedModel) {
      warnedModel = true;
      ctx.ui.notify(`heads-up: model ${config.model} not found; using the session model`, 'warning');
    }
    return configured ?? ctx.model;
  };

  /** One tool-less side request over a digest of the session. */
  const ask = async (ctx: ExtensionContext, systemPrompt: string, text: string, signal: AbortSignal) => {
    const model = resolveModel(ctx);
    if (!model) throw new Error('no model available');
    const reply = await ctx.modelRegistry.complete(
      model,
      { systemPrompt, messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }] },
      { cacheRetention: 'none', sessionId: uuidv7(), signal },
    );
    if (reply.stopReason === 'aborted') return null;
    if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'request failed');
    return reply.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();
  };

  const sessionDigest = (ctx: ExtensionContext) =>
    digest(ctx.sessionManager.buildContextEntries(), config.maxDigestChars);

  /** Returns the error message when the check failed, so a manual check can report it. */
  const runCheck = async (ctx: ExtensionContext, manual = false): Promise<string | undefined> => {
    checking = true;
    lastCheckAt = Date.now();
    inflight = new AbortController();
    const { signal } = inflight;
    try {
      const transcript = sessionDigest(ctx);
      if (!transcript.trim()) return;
      const store = readStore();
      const reply = await ask(ctx, checkSystem, checkPrompt(transcript, store.offered, store.known), signal);
      warnedError = false;
      const note = reply ? parse(reply) : null;
      if (!note || signal.aborted || shown || readStore().disabled) return;
      updateStore((s) => {
        s.offered = pushFront(s.offered, note.learn, MAX_OFFERED);
        s.events = [...s.events, { ts: Date.now(), kind: 'proposed' as const, learn: note.learn }].slice(-MAX_EVENTS);
      });
      shown = { note, view: 'collapsed', rewrite: null, at: Date.now() };
      renderBand(ctx);
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      // Background failures warn once until a check succeeds; a manual check always reports.
      if (!manual && !warnedError) ctx.ui.notify(`heads-up: check failed: ${message}`, 'warning');
      warnedError = true;
      return message;
    } finally {
      checking = false;
      if (inflight?.signal === signal) inflight = undefined;
    }
  };

  // The check runs from this timer, never inside an event handler, so a slow
  // side request never holds up the agent loop.
  const tick = (ctx: ExtensionContext) => {
    const now = Date.now();
    const due = checkWanted || (turn.running && isLong(now));
    if (!due || checking || now - lastCheckAt < cooldownMs) return;
    checkWanted = false;
    if (shown || readStore().disabled) return;
    void runCheck(ctx);
  };

  pi.on('session_start', async (_event, ctx) => {
    for (const warning of warnings) ctx.ui.notify(warning, 'warning');
    if (ctx.mode !== 'tui') return;
    if (timer) clearInterval(timer);
    timer = setInterval(() => tick(ctx), TICK_MS);
  });

  pi.on('session_shutdown', async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    inflight?.abort();
    shown = null;
    turn.running = false;
    checkWanted = false;
  });

  // A note left unanswered when the person moves on is cleared and logged.
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'extension' && shown) clearNote(ctx, 'ignored_submit');
    return { action: 'continue' } as const;
  });

  pi.on('before_agent_start', async () => {
    turn.running = true;
    turn.startedAt = Date.now();
    turn.tools = 0;
    checkWanted = false;
  });

  pi.on('tool_execution_start', async () => {
    turn.tools += 1;
  });

  pi.on('agent_end', async (event) => {
    const last = [...event.messages].reverse().find((m) => m.role === 'assistant');
    const answered = !!last && 'stopReason' in last && last.stopReason !== 'aborted' && last.stopReason !== 'error';
    if (answered && isLong(Date.now())) checkWanted = true;
    turn.running = false;
  });

  const send = (ctx: ExtensionContext, text: string) =>
    pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });

  const openPanel = async (ctx: ExtensionContext) => {
    const current = shown;
    if (ctx.mode !== 'tui' || panelOpen) return;
    if (!current) {
      ctx.ui.notify('heads-up: nothing to show', 'info');
      return;
    }
    panelOpen = true;
    renderBand(ctx);
    let action: PanelAction = 'close';
    try {
      action = await ctx.ui.custom<PanelAction>(
        (tui, theme, _kb, done) =>
          new Panel(
            tui,
            theme,
            current,
            async (variant, signal) => {
              const text = await ask(
                ctx,
                variantSystem,
                variantPrompt(sessionDigest(ctx), current.note, variant),
                signal,
              );
              return text || null;
            },
            () => logEvent('explained', current.note.learn),
            done,
          ),
      );
    } finally {
      panelOpen = false;
    }
    if (shown !== current) return renderBand(ctx);
    const { note } = current;
    switch (action) {
      case 'close':
        return renderBand(ctx);
      case 'known':
        updateStore((s) => {
          s.known = pushFront(s.known, note.learn, MAX_KNOWN);
        });
        return clearNote(ctx, 'known');
      case 'dismissed':
        return clearNote(ctx, 'dismissed');
      case 'page':
        clearNote(ctx, 'page');
        return send(ctx, pagePrompt(note));
      case 'chat':
        clearNote(ctx, 'chat');
        return send(ctx, chatPrompt(note));
    }
  };

  pi.registerShortcut(config.shortcut as Parameters<ExtensionAPI['registerShortcut']>[0], {
    description: 'Open the heads-up note',
    handler: openPanel,
  });

  pi.registerCommand('heads-up', {
    description: 'heads-up side agent: status, on, off, check, or show the current note',
    getArgumentCompletions: (prefix) =>
      ['on', 'off', 'check', 'show']
        .filter((arg) => arg.startsWith(prefix.trim()))
        .map((arg) => ({ value: arg, label: arg })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === 'on' || arg === 'off') {
        updateStore((s) => {
          s.disabled = arg === 'off';
        });
        if (arg === 'off') clearNote(ctx);
        ctx.ui.notify(`heads-up is ${arg}.`, 'info');
        return;
      }
      if (arg === 'show') return openPanel(ctx);
      if (arg === 'check') {
        if (readStore().disabled) return ctx.ui.notify('heads-up is off; /heads-up on to resume', 'info');
        if (checking) return ctx.ui.notify('heads-up: a check is already running', 'info');
        if (shown) return ctx.ui.notify(`heads-up: a note is already showing (${config.shortcut})`, 'info');
        ctx.ui.notify('heads-up: checking…', 'info');
        const error = await runCheck(ctx, true);
        if (error) ctx.ui.notify(`heads-up: check failed: ${error}`, 'warning');
        else if (!shown) ctx.ui.notify('heads-up: nothing worth flagging', 'info');
        return;
      }
      const store = readStore();
      const counts = new Map<string, number>();
      for (const e of store.events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
      const tally = [...counts].map(([kind, n]) => `${kind} ${n}`).join(', ');
      ctx.ui.notify(
        [
          `heads-up is ${store.disabled ? 'off' : 'on'}. A long turn is ${config.minTools} tool calls or ${config.minSeconds}s; checks at most every ${config.cooldownSeconds}s.`,
          `Model: ${config.model ?? 'session model'}. ${store.known.length} topics marked known.`,
          tally ? `Events: ${tally}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        'info',
      );
    },
  });
}
