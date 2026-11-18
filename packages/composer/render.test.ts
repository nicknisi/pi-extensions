import { visibleWidth } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadFrom, STATES } from './config.js';
import { ansiTheme, plainTheme, renderAll, SCENARIOS } from './fixtures.js';
import { clipStats } from './layout.js';
import { STYLES, type StyleName } from './styles.js';

const WIDTHS = [40, 80, 120, 380];
const styles = Object.keys(STYLES) as StyleName[];

beforeEach(() => {
  clipStats.count = 0;
});

describe('every style, state and width', () => {
  for (const style of styles)
    for (const theme of [plainTheme, ansiTheme])
      for (const width of WIDTHS)
        it(`${style} @ ${width} (${theme === plainTheme ? 'plain' : 'ansi'})`, () => {
          const cfg = loadFrom({ style }).config;
          for (const state of STATES) {
            const frame = renderAll(cfg, SCENARIOS[state], width, theme);
            for (const line of [...frame.above, ...frame.editor, ...frame.footer])
              expect(visibleWidth(line), `${state}: ${JSON.stringify(line)}`).toBe(width);
          }
          // Nothing was cut off to make it fit: every row was laid out to the width.
          expect(clipStats.count).toBe(0);
        });
});

const text = (lines: string[]) => lines.map((l) => l.trimEnd()).join('\n');

describe('classic', () => {
  const cfg = loadFrom({}).config;

  it('matches the 0.x box and statusline footer at 120 columns', () => {
    const frame = renderAll(cfg, SCENARIOS.idle, 120);
    expect(frame.editor[0]).toMatch(/^╭─+ Pi Footer Composer Design Mockups ─╮$/);
    expect(frame.editor[1]).toMatch(/^│ ❯ +│$/);
    expect(frame.editor[2]).toMatch(/^╰─+╯$/);
    const footer = frame.footer[0]!;
    expect(footer).toContain('Claude Opus 5.5 high │ ');
    expect(footer).toMatch(/━+╌* 71% ctx \(58K\)/);
    expect(footer.trimEnd()).toMatch(/feat\/artifact-reply-any-comment$/);
    expect(frame.above).toEqual([]);
  });

  it('keeps the context meter at 40 columns (F3), dropping lower-priority items first', () => {
    const footer = renderAll(cfg, SCENARIOS.idle, 40).footer[0]!;
    expect(footer).toContain('71%');
    expect(footer).not.toContain('goal');
  });

  it('shows the working message above the box and spins the prompt', () => {
    const frame = renderAll(cfg, SCENARIOS.working, 80);
    expect(frame.above[0]).toContain('Morse coding gravity');
    expect(frame.editor[1]).toMatch(/^│ ⠋ /);
  });
});

describe('styles', () => {
  it('toad: heavy padded box, placeholder, live tokens above', () => {
    const cfg = loadFrom({ style: 'toad' }).config;
    const idle = renderAll(cfg, SCENARIOS.idle, 80);
    expect(idle.editor[0]).toMatch(/^┏━+┓$/);
    expect(idle.editor[1]).toMatch(/^┃ +┃$/);
    expect(idle.editor[2]).toContain('Ask pi anything');
    expect(idle.footer[0]).toContain(' ‹ ');
    const working = renderAll(cfg, SCENARIOS.working, 80);
    expect(working.above[0]).toContain('1,284 tokens');
  });

  it('keycaps: key hints follow the state, context pinned right', () => {
    const cfg = loadFrom({ style: 'keycaps' }).config;
    expect(renderAll(cfg, SCENARIOS.idle, 120).footer[0]).toMatch(/ \/ +commands.*71% context left $/);
    expect(renderAll(cfg, SCENARIOS.working, 120).footer[0]).toContain('interrupt');
    // A dialog shows its own keys, so composer adds none.
    expect(renderAll(cfg, SCENARIOS.prompt, 120).footer[0]).not.toContain('interrupt');
    // The literal "esc to interrupt" only shows alongside a real working message.
    expect(renderAll(cfg, SCENARIOS.idle, 120).above).toEqual([]);
  });

  it('starship: info line above, right prompt hides once the text reaches it', () => {
    const cfg = loadFrom({ style: 'starship' }).config;
    const idle = renderAll(cfg, SCENARIOS.idle, 120);
    expect(idle.above[0]).toMatch(/pi-extensions on ⎇ feat\/artifact-reply-any-comment via ◆ Claude Opus 5.5 high/);
    expect(idle.editor.at(-1)).toMatch(/^❯ .*71%$/);
    // 73 typed characters: the right prompt still fits at 80, not at 76.
    expect(renderAll(cfg, SCENARIOS.typing, 80).editor[0]).toMatch(/columns +71%$/);
    expect(renderAll(cfg, SCENARIOS.typing, 76).editor[0]).not.toContain('71%');
    expect(idle.footer).toEqual([]);
  });

  it('sidepanel: panel beside the box when wide, folded into the footer when narrow', () => {
    const cfg = loadFrom({ style: 'sidepanel' }).config;
    const wide = renderAll(cfg, SCENARIOS.idle, 120);
    expect(wide.editor[0]).toMatch(/╮ ╭─┤◆ Claude Opus 5.5 high├─+╮$/);
    expect(wide.footer).toEqual([]);
    const narrow = renderAll(cfg, SCENARIOS.idle, 80);
    expect(narrow.editor[0]!.endsWith('╮')).toBe(true);
    expect(narrow.footer[0]).toContain('71%');
  });
});

describe('composition', () => {
  it('a slot list in composer.json replaces the style slot', () => {
    const cfg = loadFrom({ slots: { footerLeft: ['context'], footerRight: [] } }).config;
    expect(text(renderAll(cfg, SCENARIOS.idle, 80).footer)).toMatch(/^ \S+ ━+╌* 71% ctx \(58K\)$/);
  });

  it('items.<name>.priority decides what survives a narrow row', () => {
    const cfg = loadFrom({
      slots: { footerLeft: ['model', 'branch'], footerRight: [] },
      items: { branch: { priority: 99 } },
    }).config;
    const footer = renderAll(cfg, SCENARIOS.idle, 40).footer[0]!;
    expect(footer).toContain('feat/');
  });

  it('prompt symbol and spinner are configurable, per state', () => {
    const cfg = loadFrom({
      prompt: { symbol: 'λ', states: { typing: { symbol: '»' } } },
      spinner: { frames: ['◐', '◓', '◑', '◒'] },
    }).config;
    expect(renderAll(cfg, SCENARIOS.idle, 80).editor[1]).toMatch(/^│ λ /);
    expect(renderAll(cfg, SCENARIOS.typing, 80).editor[1]).toMatch(/^│ » /);
    expect(renderAll(cfg, SCENARIOS.working, 80).editor[1]).toMatch(/^│ [◐◓◑◒] /);
  });
});
