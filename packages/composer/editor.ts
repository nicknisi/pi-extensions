/**
 * The editor itself: pi's CustomEditor with composer's rendering, plus
 * paste-again-to-expand and history-recall-cursor-at-end. Rendering is
 * delegated to render.ts; this class only bridges pi's editor to it.
 *
 * Opts into embedWorkingStatus, so pi hands its working / retry /
 * compaction indicator to the editor instead of drawing a loader row. The
 * indicator is kept in the runtime and drawn wherever the `working` item is
 * slotted.
 */

import { CustomEditor, type KeybindingsManager } from '@earendil-works/pi-coding-agent';
import type { EditorTheme, TUI } from '@earendil-works/pi-tui';
import { geometry, renderEditor, type Ctx } from './render.js';
import type { IndicatorLike } from './state.js';

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

type Indicator = Parameters<CustomEditor['setWorkingStatusIndicator']>[0];

// @ts-expect-error TS2415 — handlePaste and navigateHistory are prototype methods
// typed `private` in pi-tui's Editor; overriding them is legal at runtime
// (dynamic dispatch) and is the only interception point. If this stops erroring,
// pi-tui made them protected/public — delete the expect-error pragmas here.
export class Composer extends CustomEditor {
  /** Called when a paste collapses into a `[paste #N …]` marker. */
  onCollapsedPaste?: (lines: number) => void;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly ctx: () => Ctx,
    private readonly onIndicator: (indicator: IndicatorLike | undefined) => void,
  ) {
    super(tui, theme, keybindings, { paddingX: 0, embedWorkingStatus: true });
  }

  /** Keep pi's indicator for the `working` item; never let the stock top border draw it. */
  override setWorkingStatusIndicator(indicator: Indicator): void {
    this.onIndicator(indicator);
  }

  /** pi copies its editorPaddingX setting onto custom editors; composer's spacing is box.padX. */
  override setPaddingX(_padding: number): void {
    super.setPaddingX(0);
  }

  pasteCount(): number {
    return (this as unknown as EditorInternals).pastes.size;
  }

  // ── Paste-again-to-expand ───────────────────────────────────────────────
  handlePaste(pastedText: string): void {
    const before = (this as unknown as EditorInternals).pastes.size;
    this.pasteInner(pastedText);
    const after = (this as unknown as EditorInternals).pastes.size;
    if (after > before) this.onCollapsedPaste?.(pastedText.split('\n').length);
  }

  private pasteInner(pastedText: string): void {
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

  override render(width: number): string[] {
    const ctx = this.ctx();
    const g = geometry(ctx.cfg, width);
    if (g.contentWidth < 4) return super.render(width);
    return renderEditor(ctx, width, super.render(g.contentWidth)) ?? super.render(width);
  }
}
