import { visibleWidth } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadFrom, STATES } from './config.js';
import { ansiTheme, plainTheme, renderAll, runtimeFor, SCENARIOS, stockLines } from './fixtures.js';
import { geometry, renderEditor, renderFooter } from './render.js';
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

describe('box (the default)', () => {
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

describe('slab', () => {
  const cfg = loadFrom({ style: 'slab' }).config;

  it('is a shaded slab with the same status row as box', () => {
    const slab = renderAll(cfg, SCENARIOS.idle, 120);
    const box = renderAll(loadFrom({}).config, SCENARIOS.idle, 120);
    expect(slab.editor[1]).toMatch(/^ › /);
    expect(slab.editor.some((l) => /[╭╮╰╯│]/.test(l))).toBe(false);
    expect(slab.footer).toEqual(box.footer);
  });

  it('shows the working line with elapsed time, and its "esc to interrupt" only while working', () => {
    expect(renderAll(cfg, SCENARIOS.working, 120).above[0]).toMatch(/Morse coding gravity.* │ 12s │ esc to interrupt/);
    expect(renderAll(cfg, SCENARIOS.idle, 120).above).toEqual([]);
  });
});

describe('every slot works in every style', () => {
  const SLOT_NAMES = [
    'above',
    'topLeft',
    'topRight',
    'bottomLeft',
    'bottomRight',
    'rightPrompt',
    'footerLeft',
    'footerRight',
  ];
  for (const style of styles)
    it(style, () => {
      const slots = Object.fromEntries(SLOT_NAMES.map((n) => [n, [`text:<${n}>`, 'cwd']]));
      const cfg = loadFrom({ style, slots }).config;
      const frame = renderAll(cfg, SCENARIOS.idle, 160);
      const screen = [...frame.above, ...frame.editor, ...frame.footer].join('\n');
      for (const n of SLOT_NAMES) expect(screen, n).toContain(`<${n}>`);
    });
});

describe('generic options (no style needed)', () => {
  it('heavy padded box with a placeholder', () => {
    const cfg = loadFrom({ box: { border: 'heavy', padY: 1, placeholder: 'Ask pi anything' } }).config;
    const idle = renderAll(cfg, SCENARIOS.idle, 80);
    expect(idle.editor[0]).toMatch(/^┏━.*━┓$/);
    expect(idle.editor[1]).toMatch(/^┃ +┃$/);
    expect(idle.editor[2]).toContain('Ask pi anything');
  });

  it('a right prompt hides once the text reaches it', () => {
    const cfg = loadFrom({
      box: { border: 'none', padX: 0 },
      slots: { topRight: [], rightPrompt: ['context'] },
      items: { context: { show: 'percent', label: '', icon: '' } },
    }).config;
    expect(renderAll(cfg, SCENARIOS.idle, 120).editor.at(-1)).toMatch(/^❯ .*71%$/);
    // 73 typed characters: the right prompt still fits at 80, not at 76.
    expect(renderAll(cfg, SCENARIOS.typing, 80).editor[0]).toMatch(/columns +71%$/);
    expect(renderAll(cfg, SCENARIOS.typing, 76).editor[0]).not.toContain('71%');
  });

  it('key hints follow the state, and a dialog adds none of its own', () => {
    const cfg = loadFrom({ slots: { footerLeft: ['hints'], footerRight: ['context'] } }).config;
    expect(renderAll(cfg, SCENARIOS.idle, 120).footer[0]).toMatch(/ \/ commands · @ files · ! shell/);
    expect(renderAll(cfg, SCENARIOS.working, 120).footer[0]).toContain('interrupt');
    expect(renderAll(cfg, SCENARIOS.prompt, 120).footer[0]).not.toContain('interrupt');
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

describe('/composer preview', () => {
  it('shows sample input and near-full context without an agent or real usage', () => {
    const cfg = loadFrom({}).config;
    const rt = runtimeFor(SCENARIOS.idle);
    const c = { cfg, rt, theme: plainTheme };
    const g = geometry(cfg, 80);
    rt.preview = 'typing';
    expect(renderEditor(c, 80, stockLines('', g.contentWidth))![1]).toContain('refactor the footer');
    rt.preview = 'nearFull';
    expect(renderFooter(c, 80)[0]).toContain('8% ctx');
  });
});

describe('robustness', () => {
  it('a slab background the theme does not know draws without a background instead of throwing', () => {
    const cfg = loadFrom({ style: 'slab', box: { background: 'nope' } }).config;
    const throwing = {
      ...plainTheme,
      bg: (token: string, text: string) => {
        if (token === 'nope') throw new Error('unknown bg');
        return text;
      },
    } as unknown as typeof plainTheme;
    expect(() => renderAll(cfg, SCENARIOS.idle, 80, throwing)).not.toThrow();
  });
});
