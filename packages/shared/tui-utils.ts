/**
 * Reusable TUI utilities — stolen from a Pi dashboard extension and
 * generalized just enough to drop into other TUI surfaces.
 *
 * Self-contained patterns:
 *   1. gradientText()          — per-character truecolor gradient text
 *   2. renderedText()          — render a child to a throwaway buffer + strip ANSI
 *   4. sanitizeTerminalLabel() — strip OSC/CSI/control escapes from labels
 *   6. createRenderDispatcher()— reassignable render thunk for event-driven redraws
 *
 * No runtime pi imports: pi loads this package natively, so one would load a
 * second copy of pi. renderedText() expects a RenderableNode shape compatible
 * with @earendil-works/pi-coding-agent.
 */

import { homedir } from 'node:os';
import { relative } from 'node:path';

// ─── shared renderable shape (subset of Pi's RenderableNode) ──────────────

export interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

// ─── 1. gradient text ─────────────────────────────────────────────────────

type Rgb = [number, number, number];

export const RESET = '\x1b[0m';

/** Default blue-leaning palette; override per call for a different feel. */
export const DEFAULT_PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

/**
 * Sample a wrapping gradient at `position` (0..1, wraps modulo 1) across
 * `palette`. Adjacent stops are linearly interpolated.
 */
export function sampleGradient(position: number, palette: Rgb[] = DEFAULT_PALETTE): Rgb {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * palette.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % palette.length;
  const amount = scaled - index;
  const start = palette[index]!;
  const end = palette[nextIndex]!;
  return [mix(start[0], end[0], amount), mix(start[1], end[1], amount), mix(start[2], end[2], amount)];
}

function foreground([r, g, b]: Rgb, text: string) {
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

/**
 * Render `text` with a per-character gradient. `phase` shifts the gradient
 * (use a row index * small constant to stagger multi-line art). Spaces are
 * passed through uncolored so the gradient doesn't waste hues on whitespace.
 */
export function gradientText(text: string, phase: number, palette: Rgb[] = DEFAULT_PALETTE): string {
  const chars = [...text];
  const span = Math.max(chars.length - 1, 1);
  return chars.map((ch, i) => (ch === ' ' ? ch : foreground(sampleGradient(i / span + phase, palette), ch))).join('');
}

// ─── 2. ANSI-stripping render probe ──────────────────────────────────────

/**
 * Render a node to a throwaway buffer and strip ANSI — read the text of a
 * component whose API only exposes `render(width)`.
 */
export function renderedText(node: RenderableNode, width = 200): string {
  try {
    return node.render(width).join('\n').replace(ANSI_PATTERN, '');
  } catch {
    return '';
  }
}

// ─── 4. terminal-label sanitization ───────────────────────────────────────

/* eslint-disable no-control-regex -- matching ANSI/OSC escape sequences requires control chars */
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const OSC_PATTERN = /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;
/* eslint-enable no-control-regex */

/**
 * Strip OSC, CSI, other escape sequences, and C0/C1 control chars from a
 * label before display. Use on any user-controllable or external string
 * before rendering it into a TUI — prevents escape injection and layout
 * breakage.
 */
export function sanitizeTerminalLabel(text: string): string {
  return (
    text
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '')
      .replace(ESCAPE_PATTERN, '')
      // eslint-disable-next-line no-control-regex -- intentionally strips remaining C0/C1 control chars
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  );
}

/** Collapse $HOME to ~ for display. Combined with sanitizeTerminalLabel. */
export function formatDirectory(cwd: string): string {
  const home = homedir();
  if (cwd === home) return '~';
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

// ─── 6. event-driven render dispatcher ───────────────────────────────────

/**
 * Manages a reassignable render thunk so event sources can trigger a
 * redraw without knowing which surface (header/footer) is currently bound.
 *
 * Usage:
 *   const disp = createRenderDispatcher();
 *   const off = someEvent((v) => { update(v); disp.requestRender(); });
 *   disp.bind(tui);            // point requestRender at tui.requestRender()
 *   disp.unbind();             // tear down (also stops listener if provided)
 */
export interface RenderDispatcher {
  requestRender(): void;
  bind(tui: { requestRender(force?: boolean): void }): void;
  unbind(): void;
}

export function createRenderDispatcher(): RenderDispatcher {
  let render: (() => void) | undefined;
  return {
    requestRender() {
      render?.();
    },
    bind(tui) {
      render = () => tui.requestRender();
    },
    unbind() {
      render = undefined;
    },
  };
}
