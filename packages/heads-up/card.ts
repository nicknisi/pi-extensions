import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export interface CardSpec {
  /** Pre-styled label set into the top border, left. */
  title: string;
  /** Pre-styled label set into the top border, right. Dropped when there is no room. */
  right?: string;
  /** Pre-styled body lines, already wrapped to `innerWidth(width)`. Sections are split by a rule. */
  sections: string[][];
  /** Pre-styled label set into the bottom border. Dropped when there is no room. */
  bottom?: string;
}

/** Content columns inside the card: border + one space of padding on each side. */
export const innerWidth = (width: number): number => Math.max(1, width - 4);

/**
 * A rounded box with labels set into its borders. `paint` colors the border
 * characters only; labels and body lines carry their own styling.
 */
export function card(width: number, paint: (s: string) => string, spec: CardSpec): string[] {
  const inner = innerWidth(width);
  if (width < 12) return spec.sections.flat().map((line) => truncateToWidth(line, width));

  const top = (): string => {
    const left = `${paint('╭─ ')}${spec.title} `;
    const withRight = spec.right ? ` ${spec.right}${paint(' ─╮')}` : '';
    const plain = paint('─╮');
    for (const right of [withRight, plain]) {
      if (!right) continue;
      const dashes = width - visibleWidth(left) - visibleWidth(right);
      if (dashes >= 1) return left + paint('─'.repeat(dashes)) + right;
    }
    const title = truncateToWidth(spec.title, Math.max(1, width - 6), '…');
    const head = `${paint('╭─ ')}${title} `;
    return head + paint('─'.repeat(Math.max(0, width - visibleWidth(head) - 1)) + '╮');
  };

  const bottom = (): string => {
    if (spec.bottom) {
      const left = `${paint('╰─ ')}${spec.bottom} `;
      const dashes = width - visibleWidth(left) - 1;
      if (dashes >= 1) return left + paint('─'.repeat(dashes) + '╯');
    }
    return paint(`╰${'─'.repeat(width - 2)}╯`);
  };

  const row = (line: string): string => {
    const text = truncateToWidth(line, inner, '…');
    return `${paint('│')} ${text}${' '.repeat(Math.max(0, inner - visibleWidth(text)))} ${paint('│')}`;
  };

  const rule = paint(`├${'─'.repeat(width - 2)}┤`);
  const body = spec.sections.flatMap((section, i) => [...(i > 0 ? [rule] : []), ...section.map(row)]);
  return [top(), ...body, bottom()];
}
