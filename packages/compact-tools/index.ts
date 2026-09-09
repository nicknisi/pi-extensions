import { keyText, ToolExecutionComponent, type ExtensionAPI, type Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { sanitizeTerminalLabel } from '@nicknisi/pi-shared';

// Pi has no global tool-rendering hook. These TS-private fields are shared by
// built-in, extension, MCP, and restored tool rows in Pi 0.84 and 0.85.
interface ToolRow {
  toolName: string;
  args: unknown;
  expanded: boolean;
  isPartial: boolean;
  callRendererComponent?: Component;
  resultRendererComponent?: Component;
  result?: { content: Array<{ type: string; text?: string }>; isError?: boolean };
  render(width: number): string[];
  setExpanded(expanded: boolean): void;
  handleMouse?(event: MouseEvent): { handled?: boolean } | undefined;
}

interface MouseEvent {
  type: string;
  button: string;
  y: number;
}

function renderedLines(component: Component | undefined, width: number): string[] {
  try {
    return (
      component
        ?.render(Math.max(1, width))
        .map((line) => sanitizeTerminalLabel(stripTerminalSequences(line)).trim())
        .filter(Boolean) ?? []
    );
  } catch {
    // A custom renderer can fail. Fall back to the tool's text without losing expansion.
    return [];
  }
}

function callTitle(row: ToolRow, width: number): string {
  const title = renderedLines(row.callRendererComponent, width).find((line) => /[\p{L}\p{N}]/u.test(line));
  if (title) return title;
  const args = row.args && typeof row.args === 'object' ? (row.args as Record<string, unknown>) : {};
  const detail = args.path ?? args.command ?? args.query ?? args.action ?? args.url;
  return sanitizeTerminalLabel(`${row.toolName}${typeof detail === 'string' ? ` ${detail.replace(/\s+/g, ' ')}` : ''}`);
}

function compactLines(row: ToolRow, width: number, theme: Theme): string[] {
  const title = `▸ ${callTitle(row, width - 2)}`;
  const color = row.result?.isError ? 'error' : row.isPartial ? 'warning' : 'toolOutput';
  const background = row.isPartial ? 'toolPendingBg' : row.result?.isError ? 'toolErrorBg' : 'toolSuccessBg';
  const paint = (line: string) => theme.bg(background, truncateToWidth(line, width, '…', true));
  const lines = ['', paint(theme.fg('toolTitle', title))];
  if (!row.result) return lines;

  const text = row.result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
    .split('\n')
    .map((line) => sanitizeTerminalLabel(line.replaceAll('\t', ' ')).trim())
    .filter(Boolean);
  const images = row.result.content.filter((part) => part.type === 'image').length;
  const rendered = renderedLines(row.resultRendererComponent, width - 2);
  const previewLines = rendered.length ? rendered : text;
  let preview = previewLines[0] ?? (row.isPartial ? 'Running' : 'Done');
  try {
    const value: unknown = JSON.parse(previewLines.join('\n'));
    if (Array.isArray(value)) preview = `${value.length} result items`;
    else if (value && typeof value === 'object') preview = `Structured result with ${Object.keys(value).length} fields`;
  } catch {
    if (preview === '{' || preview === '[' || preview.startsWith('{"')) preview = 'Structured output';
  }
  if (previewLines.length > 1) preview += ' …';
  if (images) preview += ` [${images} image${images === 1 ? '' : 's'}]`;
  if (row.result.isError) preview = `Error: ${preview}`;
  const hint = ` [${keyText('app.tools.expand')}]`;
  const output = truncateToWidth(`  ${preview}`, Math.max(0, width - hint.length)) + hint;
  lines.push(paint(theme.fg(color, output)));
  return lines;
}

export default function compactTools(pi: ExtensionAPI) {
  let dispose: (() => void) | undefined;

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    dispose?.();
    const prototype = ToolExecutionComponent.prototype as unknown as ToolRow;
    if (typeof prototype.render !== 'function' || typeof prototype.setExpanded !== 'function') {
      ctx.ui.notify('compact-tools: unsupported Pi tool renderer. Keeping the original display.', 'warning');
      return;
    }

    const originalRender = prototype.render;
    const originalMouse = prototype.handleMouse;
    let active = true;
    const isCompact = (row: ToolRow) => active && row.expanded === false && typeof row.toolName === 'string';

    function render(this: ToolRow, width: number): string[] {
      return isCompact(this) ? compactLines(this, width, ctx.ui.theme) : originalRender.call(this, width);
    }

    function handleMouse(this: ToolRow, event: MouseEvent) {
      if (!isCompact(this)) return originalMouse?.call(this, event);
      // Hidden children must not receive input at their old, expanded positions.
      // Unhandled wheel/drag events remain available to transcript scrolling/selection.
      if (this.result && event.y > 0 && event.type === 'click' && event.button === 'left') {
        this.setExpanded(true);
        return { handled: true };
      }
      return undefined;
    }

    prototype.render = render;
    prototype.handleMouse = handleMouse;
    dispose = () => {
      // A later extension may wrap us. In that case leave its wrapper intact,
      // but make our captured functions pass through after this session ends.
      active = false;
      if (prototype.render === render) prototype.render = originalRender;
      if (prototype.handleMouse === handleMouse) {
        if (originalMouse) prototype.handleMouse = originalMouse;
        else delete prototype.handleMouse;
      }
    };
    ctx.ui.setToolsExpanded(false);
    // setToolsExpanded is a no-op when already collapsed. Clear our unused status
    // to request a redraw even then, without adding a visible widget or message.
    ctx.ui.setStatus('compact-tools', undefined);
  });

  pi.on('session_shutdown', () => {
    dispose?.();
    dispose = undefined;
  });
}
