/**
 * Chat Input Extension
 *
 * Replaces pi's input editor with a configurable boxed input. All native
 * editor features — cursor movement, history, autocomplete, paste — work
 * normally inside the box. Also implements paste-again-to-expand: when a
 * collapsed `[paste #N ...]` marker is present, pasting the same content
 * again expands it inline so you can see and edit the actual text.
 *
 * Evolved from the earlier `box-editor.ts`: the rendering is now
 * config-driven (~/.pi/agent/configs/composer.json) and supports a
 * prefix glyph, boxed/unboxed modes, configurable padding, menu gap,
 * rounded vs square corners, a configurable session-name inlay in the border
 * (shown only when the session has a name — or another extension has pushed
 * label text over the `pi.events` bus; see the README's Extension API), and
 * working-state animations (spinner prefix and border glow while the agent
 * works). The rounded ╭╮│╰╯ corners remain the default to preserve the
 * original look. Paste-expand behavior was merged in from the former
 * standalone `paste-expand.ts` so the two features don't fight over
 * `setEditorComponent` (last-call-wins).
 *
 * Layout (boxed):
 *   ╭──────────────────────────╮
 *   │ ❯ <content>               │
 *   │   <content continued>     │
 *   ╰──────────────────────────╯
 *   <autocomplete menu>
 *
 * The prefix (default ❯, any cell width) is shown only on the first body line;
 * subsequent lines are indented by the prefix's width so content aligns.
 * Autocomplete lines render below the box, indented by `extraMenuIndent`.
 */

// ─── Paste-again-to-expand ────────────────────────────────────────────────
// Pi collapses large pastes (>10 lines or >1000 chars) into a `[paste #N ...]`
// marker. Pasting the same content again while the marker is present expands
// it inline. Reaches into pi-tui Editor internals (state, pastes registry)
// that are TS-private but runtime-accessible; may need updating if pi-tui
// changes its paste-marker format or registry bookkeeping.

const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Replicates pi-tui's paste cleanup so an incoming paste can be compared
 * against already-collapsed paste content. */
function cleanPastedText(text: string): string {
  // Decode CSI-u Ctrl+<letter> sequences some terminals emit inside bracketed paste
  const decoded = text.replace(/\x1b\[(\d+);5u/g, (match, code) => {
    const cp = Number(code);
    if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
    if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
    return match;
  });
  // normalizeText: CRLF/CR -> LF, tabs -> 4 spaces
  const normalized = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '    ');
  // Strip non-printables except newline
  return normalized
    .split('')
    .filter((c) => c === '\n' || c.charCodeAt(0) >= 32)
    .join('');
}

// pi-tui Editor privates we touch at runtime
interface EditorInternals {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pastes: Map<number, string>;
  pasteCounter: number;
  lastAction: unknown;
  historyIndex: number;
  pushUndoSnapshot(): void;
  cancelAutocomplete(): void;
  exitHistoryBrowsing(): void;
  setCursorCol(col: number): void;
  moveToLineEnd(): void;
}

import { execFileSync } from 'node:child_process';
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TUI, EditorTheme } from '@earendil-works/pi-tui';
import type { KeybindingsManager } from '@earendil-works/pi-coding-agent';
import { isViewportTUI, visibleWidth } from '@earendil-works/pi-tui';
import { CONFIG, configLoadError, reloadConfig } from './config.js';
import {
  applyColor,
  mixRgb,
  paneHasFocusedClient,
  parseFocusInput,
  parseLabelData,
  plainText,
  rainbowRgb,
  resolveRgb,
  rgbColor,
  splitFormat,
  truncateCells,
} from './utils.js';

// Corner glyphs per style.
const CORNERS = {
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', side: '│' },
  square: { tl: '┌', tr: '┐', bl: '└', br: '┘', side: '│' },
} as const;

// ─── Border / scroll detection on pi's stock render output ────────────────

/** Solid border: every visible char is ─. */
function isSolidBorder(line: string): boolean {
  return plainText(line).replace(/─/g, '').length === 0;
}

/** Extract the `↑ N more` / `↓ N more` scroll indicator, or null. */
function getScrollText(line: string): string | null {
  const plain = plainText(line);
  if (!plain.startsWith('─')) return null;
  const m = plain.match(/((?:↑|↓)\s*\d+\s*more)/);
  return m?.[1] ?? null;
}

function isBorderLike(line: string): boolean {
  return isSolidBorder(line) || getScrollText(line) !== null;
}

/** Prefix width in terminal cells — layout math supports multi-cell prefixes.
 * When the spinner is enabled the slot is sized to the widest frame so the
 * layout doesn't shift while animating. Recomputed on config reload. */
let PREFIX_W = prefixWidth();

function prefixWidth(): number {
  return Math.max(
    1,
    visibleWidth(CONFIG.PREFIX),
    ...(CONFIG.SPINNER ? CONFIG.SPINNER_FRAMES.map((f) => visibleWidth(f)) : []),
  );
}

// ─── Working-state animation (spinner prefix + border glow) ───────────────
// Busy between agent_start and agent_settled (or during a /composer
// preview). A single timer drives both animations by requesting renders;
// frames/phases derive from Date.now() so they stay smooth regardless of
// tick jitter. pi-tui's invalidate() is a no-op — requestRender() is the
// only way to repaint from a timer.

let agentBusy = false;
let agentRunning = false; // real agent run in flight (vs. preview-only busy)
let busySince = 0;

/** Current session display name, inlaid in the top border when set. pi never
 * auto-names sessions, so any value here was set deliberately — via /name,
 * --name, or an extension such as session-name. */
let sessionName: string | undefined;

/** Label text pushed by another extension via the `composer:set-label` bus
 * event; takes precedence over the session name. Cleared and re-requested on
 * every session start so a stale label never leaks across sessions. */
let labelOverride: string | undefined;
let animTimer: ReturnType<typeof setInterval> | undefined;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let animTui: TUI | undefined;

function startAnimation(): void {
  if (animTimer || !animTui) return;
  if (!CONFIG.SPINNER && !CONFIG.GLOW) return;
  const tickMs = Math.min(CONFIG.SPINNER ? CONFIG.SPINNER_INTERVAL_MS : Infinity, CONFIG.GLOW ? 80 : Infinity);
  animTimer = setInterval(() => animTui?.requestRender(), tickMs);
  animTimer.unref?.();
}

function stopAnimation(): void {
  if (animTimer) clearInterval(animTimer);
  animTimer = undefined;
}

function beginBusy(): void {
  agentBusy = true;
  busySince = Date.now();
  startAnimation();
}

function endBusy(): void {
  agentBusy = false;
  stopAnimation();
  animTui?.requestRender();
}

function cancelPreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = undefined;
}

function spinnerFrame(): string {
  const frames = CONFIG.SPINNER_FRAMES;
  return frames[Math.floor((Date.now() - busySince) / CONFIG.SPINNER_INTERVAL_MS) % frames.length]!;
}

/** 0..1 breathing intensity for the pulse glow. */
function pulsePhase(): number {
  return (1 - Math.cos((2 * Math.PI * (Date.now() % CONFIG.GLOW_PERIOD_MS)) / CONFIG.GLOW_PERIOD_MS)) / 2;
}

/** Locate pi's stock top/bottom borders and their scroll indicators in a render. */
function scanBorders(stock: string[]): {
  firstIdx: number;
  lastIdx: number;
  topScroll: string | null;
  bottomScroll: string | null;
} {
  const firstIdx = stock.findIndex(isBorderLike);
  let lastIdx = -1;
  for (let i = stock.length - 1; i >= 0; i--) {
    if (isBorderLike(stock[i]!)) {
      lastIdx = i;
      break;
    }
  }
  const topScroll = firstIdx !== -1 ? getScrollText(stock[firstIdx]!) : null;
  const bottomScroll = lastIdx !== -1 && lastIdx !== firstIdx ? getScrollText(stock[lastIdx]!) : null;
  return { firstIdx, lastIdx, topScroll, bottomScroll };
}

/** Autocomplete-menu lines (after the last stock border), indented and padded to width. */
function menuLines(stock: string[], lastIdx: number, width: number): string[] {
  if (lastIdx === -1) return [];
  const indent = ' '.repeat(CONFIG.EXTRA_MENU_INDENT);
  const menu: string[] = [];
  for (let i = lastIdx + 1; i < stock.length; i++) {
    const vw = visibleWidth(stock[i]!);
    const fill = vw + CONFIG.EXTRA_MENU_INDENT < width ? ' '.repeat(width - vw - CONFIG.EXTRA_MENU_INDENT) : '';
    menu.push(indent + stock[i]! + fill);
  }
  return menu;
}

// ─── Component ────────────────────────────────────────────────────────────

interface Palette {
  border: (s: string) => string;
  accent: (s: string) => string;
  spin: (s: string) => string;
  glow: (s: string) => string;
  name: (s: string) => string;
}

// @ts-expect-error TS2415 — handlePaste is a prototype method typed `private` in
// pi-tui's Editor; overriding it is legal at runtime (dynamic dispatch) and is the
// only interception point for paste handling. If this stops erroring, pi-tui made
// it protected/public — delete both expect-error pragmas in this file.
class Composer extends CustomEditor {
  private border: (s: string) => string;
  private accent: (s: string) => string;
  private spin: (s: string) => string;
  private glow: (s: string) => string;
  private name: (s: string) => string;

  // Read from CONFIG at render time so a config reload takes effect live.
  private get corners() {
    return CORNERS[CONFIG.CORNERS];
  }

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, palette: Palette) {
    super(tui, theme, keybindings, { paddingX: 0 });
    this.border = palette.border;
    this.accent = palette.accent;
    this.spin = palette.spin;
    this.glow = palette.glow;
    this.name = palette.name;
  }

  // ── Paste-again-to-expand ───────────────────────────────────────────────
  handlePaste(pastedText: string): void {
    const self = this as unknown as EditorInternals;
    if (self.pastes.size > 0) {
      const cleaned = cleanPastedText(pastedText);
      for (const [id, content] of self.pastes) {
        // handlePaste may have prepended a space to path-like pastes
        if (content !== cleaned && content !== ` ${cleaned}`) continue;
        const markerRe = new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`);
        if (!markerRe.test(this.getText())) continue;
        this.expandCollapsedPaste(id, content);
        return;
      }
    }
    // @ts-expect-error TS2855 — see class-level note: parent method is typed private.
    super.handlePaste(pastedText);
  }

  // ── History recall: cursor at the end ─────────────────────────────────
  // pi-tui's navigateHistory places the cursor at the *start* of an entry
  // recalled with Up (so a second Up keeps browsing history in multi-line
  // entries). The cost is the overwhelmingly common case — recall the
  // message you just sent and keep typing — which then prepends to your own
  // sentence. Prefer the common case; Down is untouched. Ported from
  // workos/arc's editor-history-cursor extension.
  navigateHistory(direction: number): void {
    const self = this as unknown as EditorInternals;
    const previousHistoryIndex = self.historyIndex;
    // @ts-expect-error TS2855 — see class-level note: parent method is typed private.
    super.navigateHistory(direction);
    // Only the Up case, and only when an entry was actually recalled:
    // historyIndex -1 means the user's in-progress draft was restored, whose
    // cursor position should be preserved exactly as it was, and an unchanged
    // index means the original was a boundary no-op (already at the oldest
    // entry), where moving the cursor would disrupt in-place editing.
    if (direction !== -1 || self.historyIndex < 0 || self.historyIndex === previousHistoryIndex) return;
    self.state.cursorLine = Math.max(0, self.state.lines.length - 1);
    self.moveToLineEnd();
  }

  /** Replace the collapsed marker for paste `id` with its real content,
   * keeping the paste registry dense (same bookkeeping as marker deletion). */
  private expandCollapsedPaste(id: number, content: string): void {
    const self = this as unknown as EditorInternals;
    self.cancelAutocomplete();
    self.exitHistoryBrowsing();
    self.lastAction = null;
    self.pushUndoSnapshot();

    const markerRe = new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`);

    // Markers are atomic single-line segments; find the line containing it
    let lineIdx = -1;
    let match: RegExpExecArray | null = null;
    for (let i = 0; i < self.state.lines.length; i++) {
      const m = markerRe.exec(self.state.lines[i]!);
      if (m) {
        lineIdx = i;
        match = m;
        break;
      }
    }
    if (lineIdx === -1 || !match) return;

    const line = self.state.lines[lineIdx]!;
    const before = line.slice(0, match.index);
    const after = line.slice(match.index + match[0].length);
    self.state.lines.splice(lineIdx, 1, ...(before + content + after).split('\n'));

    // Remove registry entry, shift higher ids down, renumber their markers
    self.pastes.delete(id);
    self.pasteCounter--;
    const higher = [...self.pastes.keys()].filter((k) => k > id).sort((a, b) => a - b);
    for (const k of higher) {
      self.pastes.set(k - 1, self.pastes.get(k)!);
      self.pastes.delete(k);
    }
    self.state.lines = self.state.lines.map((l) =>
      l.replace(PASTE_MARKER_REGEX, (full, idGroup, suffix) =>
        Number(idGroup) <= id ? full : `[paste #${Number(idGroup) - 1}${suffix ?? ''}]`,
      ),
    );

    // Cursor to end of the expanded content
    const contentLines = content.split('\n');
    self.state.cursorLine = lineIdx + contentLines.length - 1;
    self.setCursorCol(
      contentLines.length === 1 ? before.length + content.length : contentLines[contentLines.length - 1]!.length,
    );

    if (this.onChange) this.onChange(this.getText());
  }

  render(width: number): string[] {
    const padMultiplier = CONFIG.BOXED_VIEW ? 3 : 1;
    if (width < 4 + PREFIX_W + CONFIG.BOX_PAD_X * padMultiplier) return super.render(width);

    const contentWidth = CONFIG.BOXED_VIEW
      ? width - 2 - CONFIG.BOX_PAD_X * 3 - PREFIX_W
      : width - 2 * CONFIG.BOX_PAD_X - PREFIX_W;
    const stock = super.render(contentWidth);
    if (stock.length < 2) return super.render(width);

    return CONFIG.BOXED_VIEW
      ? this.renderBoxed(stock, contentWidth, width)
      : this.renderUnboxed(stock, contentWidth, width);
  }

  /** A horizontal rule of `width` cells, with the scroll indicator inlaid when present. */
  private rule(scroll: string | null, width: number): string {
    if (!scroll) {
      if (agentBusy && CONFIG.GLOW && CONFIG.GLOW_STYLE === 'shimmer') return this.shimmerRule(width);
      return this.border('─'.repeat(width));
    }
    const label = `── ${scroll} `;
    return this.border(label) + this.border('─'.repeat(Math.max(0, width - visibleWidth(label))));
  }

  /** A rule with a glowing highlight sweeping left → right. */
  private shimmerRule(width: number): string {
    const win = Math.max(3, Math.min(10, Math.floor(width / 6)));
    const cycle = width + win;
    const head = Math.floor(((Date.now() % CONFIG.GLOW_PERIOD_MS) / CONFIG.GLOW_PERIOD_MS) * cycle);
    const left = Math.max(0, head - win);
    const right = Math.min(width, head);
    if (right <= left) return this.border('─'.repeat(width));
    return this.border('─'.repeat(left)) + this.glow('─'.repeat(right - left)) + this.border('─'.repeat(width - right));
  }

  /** Session-name label segment built from SESSION_NAME_FORMAT — surround
   * glyphs in the border colour, the name in the name colour — or null when
   * the session is unnamed or the rule is too narrow (keeps at least 8 cells
   * of plain rule). */
  private sessionNameLabel(width: number): { text: string; width: number } | null {
    const label = labelOverride ?? sessionName;
    if (!CONFIG.SESSION_NAME || !label) return null;
    const [pre, post] = splitFormat(CONFIG.SESSION_NAME_FORMAT);
    const surroundW = visibleWidth(pre) + visibleWidth(post);
    const fit = width - 8 - surroundW;
    const cap = CONFIG.SESSION_NAME_MAX_WIDTH > 0 ? Math.min(CONFIG.SESSION_NAME_MAX_WIDTH, fit) : fit;
    if (cap < 4) return null;
    const name = truncateCells(label, cap);
    return {
      text: this.border(pre) + this.name(name) + this.border(post),
      width: surroundW + visibleWidth(name),
    };
  }

  /** A rule carrying the session-name inlay when `which` is the configured
   * border, placed at the configured end. The remaining stretch keeps the
   * usual scroll indicator and shimmer behaviour, shortened by the label. */
  private labeledRule(scroll: string | null, width: number, which: 'top' | 'bottom'): string {
    if (CONFIG.SESSION_NAME_BORDER !== which) return this.rule(scroll, width);
    const label = this.sessionNameLabel(width);
    if (!label) return this.rule(scroll, width);
    const rest = this.rule(scroll, width - label.width);
    return CONFIG.SESSION_NAME_POSITION === 'left' ? label.text + rest : rest + label.text;
  }

  /** First-line prefix: spinner frame while the agent works, glyph otherwise.
   * Always padded to PREFIX_W so the layout never shifts. */
  private prefixGlyph(): string {
    const spinning = agentBusy && CONFIG.SPINNER;
    const glyph = spinning ? spinnerFrame() : CONFIG.PREFIX;
    const painted = spinning ? this.spin(glyph) : this.accent(glyph);
    return painted + ' '.repeat(Math.max(0, PREFIX_W - visibleWidth(glyph)));
  }

  /** Body lines (between the stock borders): pad + prefix + content, then `wrap`. */
  private bodyLines(
    stock: string[],
    firstIdx: number,
    lastIdx: number,
    contentWidth: number,
    wrap: (inner: string) => string,
  ): string[] {
    const pad = ' '.repeat(CONFIG.BOX_PAD_X);
    const body: string[] = [];
    let isFirst = true;
    for (let i = 0; i < stock.length; i++) {
      if (i === firstIdx || i === lastIdx) continue;
      if (lastIdx !== -1 && i > lastIdx) continue;
      const vw = visibleWidth(stock[i]!);
      const fill = vw < contentWidth ? ' '.repeat(contentWidth - vw) : '';
      const prefixStr = isFirst ? this.prefixGlyph() : ' '.repeat(PREFIX_W);
      body.push(wrap(pad + prefixStr + pad + stock[i]! + fill));
      isFirst = false;
    }
    return body;
  }

  private renderBoxed(stock: string[], contentWidth: number, width: number): string[] {
    const c = this.corners;
    const innerWidth = width - 2;
    const { firstIdx, lastIdx, topScroll, bottomScroll } = scanBorders(stock);
    const pad = ' '.repeat(CONFIG.BOX_PAD_X);

    const top = this.border(c.tl) + this.labeledRule(topScroll, innerWidth, 'top') + this.border(c.tr);
    const bottom = this.border(c.bl) + this.labeledRule(bottomScroll, innerWidth, 'bottom') + this.border(c.br);
    const body = this.bodyLines(
      stock,
      firstIdx,
      lastIdx,
      contentWidth,
      (inner) => this.border(c.side) + inner + pad + this.border(c.side),
    );

    const gap = Array.from({ length: CONFIG.MENU_GAP }, () => '');
    return [top, ...body, bottom, ...gap, ...menuLines(stock, lastIdx, width)];
  }

  private renderUnboxed(stock: string[], contentWidth: number, width: number): string[] {
    const { firstIdx, lastIdx, topScroll, bottomScroll } = scanBorders(stock);

    const top = this.labeledRule(topScroll, width, 'top');
    const bottom = this.labeledRule(bottomScroll, width, 'bottom');
    const body = this.bodyLines(stock, firstIdx, lastIdx, contentWidth, (inner) => inner);

    const gap = Array.from({ length: CONFIG.MENU_GAP }, () => '');
    return [top, ...body, bottom, ...gap, ...menuLines(stock, lastIdx, width)];
  }
}

// ─── Extension entry ──────────────────────────────────────────────────────

// Terminal focus tracking — delineates the focused tmux pane. Fullscreen pi
// owns DECSET 1004; other TUI modes need composer to enable it so tmux (with
// `focus-events on`) sends CSI I / CSI O. Observe raw stdin because fullscreen
// pi consumes those events before extension input listeners run. When composer
// enables 1004 itself, clean it up so the shell does not inherit `[I`/`[O`.

let paneFocused = true;
let focusCarry = '';
let removeFocusListener: (() => void) | undefined;
let ownsFocusReporting = false;
let exitHookInstalled = false;

function detectPaneFocus(): boolean {
  if (!process.env.TMUX_PANE) return true;
  try {
    return paneHasFocusedClient(
      process.env.TMUX_PANE,
      execFileSync('tmux', ['list-clients', '-F', '#{client_flags}\t#{pane_id}'], { encoding: 'utf8' }),
    );
  } catch {
    return true;
  }
}

function enableFocusTracking(tui: TUI): void {
  paneFocused = detectPaneFocus();
  ownsFocusReporting = !isViewportTUI(tui);
  process.stdout.write('\x1b[?1004h');
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      if (!ownsFocusReporting) return;
      try {
        process.stdout.write('\x1b[?1004l');
      } catch {
        /* stdout gone */
      }
    });
  }
  removeFocusListener?.();
  const onInput = (data: string | Buffer) => {
    const parsed = parseFocusInput(focusCarry, String(data));
    focusCarry = parsed.carry;
    if (parsed.focused === undefined) return;
    paneFocused = parsed.focused;
    tui.requestRender();
  };
  process.stdin.on('data', onInput);
  removeFocusListener = () => process.stdin.off('data', onInput);
}

function disableFocusTracking(): void {
  if (ownsFocusReporting) {
    try {
      process.stdout.write('\x1b[?1004l');
    } catch {
      /* stdout gone */
    }
  }
  removeFocusListener?.();
  removeFocusListener = undefined;
  ownsFocusReporting = false;
  focusCarry = '';
  paneFocused = true;
}

export default function composer(pi: ExtensionAPI) {
  // Extension API over pi's shared event bus: another extension pushes label
  // text with pi.events.emit('composer:set-label', { text }); an absent or
  // empty text clears the override. Composer re-emits 'composer:label-request'
  // on every session start so producers can re-push regardless of load order.
  pi.events.on('composer:set-label', (data) => {
    labelOverride = parseLabelData(data);
    animTui?.requestRender();
  });

  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    sessionName = pi.getSessionName() || undefined;
    labelOverride = undefined;
    pi.events.emit('composer:label-request', {});
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      // All palette fns read CONFIG.* at call time so /composer reloads
      // take effect without rebuilding the editor component.
      const restingBorder = (s: string) =>
        applyColor(
          ctx.ui.theme,
          CONFIG.FOCUS_INDICATOR && paneFocused ? CONFIG.FOCUSED_BORDER_COLOR : CONFIG.BORDER_COLOR,
          s,
        );

      // Paint with a colour name that may be a theme token, hex, or the
      // special "rainbow" value (hue rotates once per rainbowPeriodMs).
      const paint = (color: string, s: string): string =>
        color === 'rainbow' ? rgbColor(rainbowRgb(CONFIG.RAINBOW_PERIOD_MS), s) : applyColor(ctx.ui.theme, color, s);

      // Pulse glow: interpolate borderColor toward the glow colour. Anchoring
      // on borderColor (not the focus-adjusted resting colour) keeps the
      // default visible: with focusIndicator on, the focused resting border
      // is accent, and an accent→accent pulse would be a no-op. Falls back to
      // a steady glow colour when either endpoint can't be resolved to RGB
      // (non-truecolor theme tokens).
      const pulseBorder = (s: string): string => {
        const glowRgb =
          CONFIG.GLOW_COLOR === 'rainbow'
            ? rainbowRgb(CONFIG.RAINBOW_PERIOD_MS)
            : resolveRgb(ctx.ui.theme, CONFIG.GLOW_COLOR);
        const baseRgb = resolveRgb(ctx.ui.theme, CONFIG.BORDER_COLOR);
        if (!baseRgb || !glowRgb) return paint(CONFIG.GLOW_COLOR, s);
        return rgbColor(mixRgb(baseRgb, glowRgb, pulsePhase()), s);
      };

      const borderFn = (s: string) =>
        agentBusy && CONFIG.GLOW && CONFIG.GLOW_STYLE === 'pulse' ? pulseBorder(s) : restingBorder(s);

      if (CONFIG.FOCUS_INDICATOR) enableFocusTracking(tui);
      animTui = tui;
      return new Composer(tui, theme, kb, {
        border: borderFn,
        accent: (s: string) => applyColor(ctx.ui.theme, CONFIG.PREFIX_COLOR, s),
        spin: (s: string) => paint(CONFIG.SPINNER_COLOR, s),
        glow: (s: string) => paint(CONFIG.GLOW_COLOR, s),
        name: (s: string) => applyColor(ctx.ui.theme, CONFIG.SESSION_NAME_COLOR, s),
      });
    });

    const loadError = configLoadError();
    if (loadError) ctx.ui.notify(`composer.json ignored (using defaults): ${loadError}`, 'warning');
  });

  pi.registerCommand('composer', {
    description: 'Reload composer.json and preview the working animation',
    handler: async (_args, ctx) => {
      const error = reloadConfig();
      if (error) {
        ctx.ui.notify(`composer.json not applied (kept previous config): ${error}`, 'error');
        return;
      }
      PREFIX_W = prefixWidth();
      if (animTui) {
        if (CONFIG.FOCUS_INDICATOR) enableFocusTracking(animTui);
        else disableFocusTracking();
      }
      if (agentBusy) {
        // Restart the timer so a changed spinner interval takes effect.
        stopAnimation();
        startAnimation();
      }
      ctx.ui.notify('composer config reloaded', 'info');
      animTui?.requestRender();

      // Fake a short busy window so the spinner/glow can be seen without
      // sending a prompt. A real agent run takes over seamlessly.
      if (!agentRunning && (CONFIG.SPINNER || CONFIG.GLOW)) {
        cancelPreview();
        beginBusy();
        previewTimer = setTimeout(() => {
          previewTimer = undefined;
          if (!agentRunning) endBusy();
        }, 3000);
        previewTimer.unref?.();
      }
    },
  });

  pi.on('session_info_changed', (event, ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    sessionName = event.name || undefined;
    animTui?.requestRender();
  });

  pi.on('agent_start', (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    agentRunning = true;
    cancelPreview();
    beginBusy();
  });

  pi.on('agent_settled', (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    agentRunning = false;
    endBusy();
  });

  pi.on('session_shutdown', (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    if (CONFIG.FOCUS_INDICATOR) disableFocusTracking();
    cancelPreview();
    agentRunning = false;
    agentBusy = false;
    stopAnimation();
    animTui = undefined;
    sessionName = undefined;
    labelOverride = undefined;
    ctx.ui.setEditorComponent(undefined);
  });
}
