import {
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolRenderers,
} from '@earendil-works/pi-coding-agent';
import { Box, stripTerminalSequences, Text, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { sanitizeTerminalLabel } from '@nicknisi/pi-shared';

type ToolRenderContext = Parameters<NonNullable<ToolRenderers['renderCall']>>[2];

// Shared per-row renderer state; tells the call frame whether a result frame follows it.
const HAS_RESULT = 'compactToolsHasResult';

// Pi's collapsed-output truncation hints, e.g. `... (12 earlier lines, ctrl+o to expand)`.
const TRUNCATION_HINT = /^\.\.\. \(?\d+ (?:earlier|more) lines\b/;
// Collapsed previews only need the start of the output; avoid splitting or parsing huge results every render.
const PREVIEW_CHARS = 64 * 1024;

function renderedLines(component: Component | undefined, width: number): string[] {
  try {
    return (
      component
        ?.render(Math.max(1, width))
        .map((line) => sanitizeTerminalLabel(stripTerminalSequences(line)).trim())
        .filter((line) => line && !TRUNCATION_HINT.test(line)) ?? []
    );
  } catch {
    // A custom renderer can fail. Fall back to the tool's text without losing expansion.
    return [];
  }
}

function argsTitle(toolName: string, args: unknown): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const detail = record.path ?? record.command ?? record.query ?? record.action ?? record.url;
  return sanitizeTerminalLabel(`${toolName}${typeof detail === 'string' ? ` ${detail.replace(/\s+/g, ' ')}` : ''}`);
}

function background(context: ToolRenderContext): 'toolPendingBg' | 'toolErrorBg' | 'toolSuccessBg' {
  return context.isPartial ? 'toolPendingBg' : context.isError ? 'toolErrorBg' : 'toolSuccessBg';
}

function textOf(result: AgentToolResult<unknown>, limit = Infinity): string[] {
  let text = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  if (text.length > limit) text = text.slice(0, limit);
  return text
    .split('\n')
    .map((line) => sanitizeTerminalLabel(line.replaceAll('\t', ' ')).trim())
    .filter(Boolean);
}

/**
 * One painted, width-filling line computed at render time, indented by outputPad like pi's default shell.
 * Pi rebuilds this component whenever the row's inputs change, so the line is cached per width.
 */
class Line implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  constructor(
    readonly inner: Component | undefined,
    private readonly line: (width: number) => string,
    private readonly paint: (text: string) => string,
    private readonly pad = 0,
  ) {}
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const pad = Math.max(0, this.pad);
    const inner = Math.max(0, width - pad * 2);
    const text = ' '.repeat(pad) + truncateToWidth(this.line(inner), inner, '…');
    this.cachedWidth = width;
    this.cachedLines = [this.paint(truncateToWidth(text, width, '…', true))];
    return this.cachedLines;
  }
  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/** Pi's default tool shell (outcome background, outputPad, one blank line above and below), for one slot. */
class Frame extends Box {
  constructor(
    readonly inner: Component,
    private readonly paint: (text: string) => string,
    private readonly top: boolean,
    private readonly bottom: () => boolean,
    outputPad: number,
  ) {
    super(outputPad, 0, paint);
    this.addChild(inner);
  }
  override render(width: number): string[] {
    const blank = this.paint(' '.repeat(Math.max(0, width)));
    return [...(this.top ? [blank] : []), ...super.render(width), ...(this.bottom() ? [blank] : [])];
  }
  override handleMouse(event: Parameters<Box['handleMouse']>[0]) {
    if (!this.top) return super.handleMouse(event);
    return event.y < 1 ? undefined : super.handleMouse({ ...event, y: event.y - 1 });
  }
}

function compactRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
  const passthrough = base?.renderShell === 'self';
  const innerContext = (context: ToolRenderContext): ToolRenderContext => ({
    ...context,
    // Base renderers reuse their own previous component, never our wrapper.
    lastComponent:
      context.lastComponent instanceof Frame || context.lastComponent instanceof Line
        ? context.lastComponent.inner
        : context.lastComponent,
  });
  const paint = (theme: Theme, context: ToolRenderContext) => (text: string) => theme.bg(background(context), text);

  return {
    // Self shell so collapsed rows are exactly two lines; expanded rows re-create pi's default box below.
    renderShell: 'self',
    renderCall(args, theme, context) {
      const state = context.state as Record<string, unknown>;
      const call = () => {
        try {
          return base?.renderCall?.(args, theme, innerContext(context));
        } catch {
          return undefined;
        }
      };
      if (context.expanded) {
        const component = call() ?? new Text(theme.fg('toolTitle', argsTitle(toolName, args)), 0, 0);
        if (passthrough) return component;
        return new Frame(component, paint(theme, context), true, () => !state[HAS_RESULT], context.outputPad);
      }
      const component = call();
      return new Line(
        component,
        (width) => {
          const title = renderedLines(component, width - 2).find((line) => /[\p{L}\p{N}]/u.test(line));
          return theme.fg('toolTitle', `▸ ${title ?? argsTitle(toolName, args)}`);
        },
        paint(theme, context),
        context.outputPad,
      );
    },
    renderResult(result, options, theme, context) {
      (context.state as Record<string, unknown>)[HAS_RESULT] = true;
      const render = (expanded: boolean) => {
        try {
          return base?.renderResult?.(result, { ...options, expanded }, theme, innerContext(context));
        } catch {
          return undefined;
        }
      };
      if (options.expanded) {
        const component =
          render(true) ??
          new Text(
            textOf(result)
              .map((line) => theme.fg('toolOutput', line))
              .join('\n'),
            0,
            0,
          );
        if (passthrough) return component;
        return new Frame(component, paint(theme, context), false, () => true, context.outputPad);
      }
      const component = render(false);
      const color = context.isError ? 'error' : options.isPartial ? 'warning' : 'toolOutput';
      return new Line(
        component,
        (width) => {
          const rendered = renderedLines(component, width - 2);
          const previewLines = rendered.length ? rendered : textOf(result, PREVIEW_CHARS);
          let preview = previewLines[0] ?? (options.isPartial ? 'Running' : 'Done');
          try {
            const value: unknown = JSON.parse(previewLines.join('\n'));
            if (Array.isArray(value)) preview = `${value.length} result items`;
            else if (value && typeof value === 'object')
              preview = `Structured result with ${Object.keys(value).length} fields`;
          } catch {
            if (preview === '{' || preview === '[' || preview.startsWith('{"')) preview = 'Structured output';
          }
          if (previewLines.length > 1) preview += ' …';
          const images = result.content.filter((part) => part.type === 'image').length;
          if (images) preview += ` [${images} image${images === 1 ? '' : 's'}]`;
          if (context.isError) preview = `Error: ${preview}`;
          const key = context.keyText('app.tools.expand');
          const hint = key ? ` [${key}]` : '';
          return theme.fg(color, truncateToWidth(`  ${preview}`, Math.max(0, width - hint.length)) + hint);
        },
        paint(theme, context),
        context.outputPad,
      );
    },
  };
}

export default function compactTools(pi: ExtensionAPI) {
  pi.registerToolRenderer((toolName, next) => compactRenderers(toolName, next()));

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setToolsExpanded(false);
    // setToolsExpanded is a no-op when already collapsed. Clear our unused status
    // to request a redraw even then, without adding a visible widget or message.
    ctx.ui.setStatus('compact-tools', undefined);
  });
}
