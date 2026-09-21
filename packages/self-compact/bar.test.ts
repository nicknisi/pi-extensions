import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  BAR_CELLS,
  contextBarLine,
  latestApplicableCacheRead,
  renderBarCells,
  renderBarLine,
  type BarInput,
} from './extensions/self-compact/bar.js';

const markers = { softPercent: 20, warningPercent: 50, hardPercent: 60 };

function input(overrides: Partial<BarInput>): BarInput {
  return { usedPercent: 0, cachedPercent: null, ...markers, ...overrides };
}

describe('context widget', () => {
  it('renders exactly 20 cells inside brackets', () => {
    const line = renderBarLine(input({ usedPercent: 40, cachedPercent: 20 }));
    const cells = line.slice(1, line.indexOf(']'));
    expect(cells.length).toBe(BAR_CELLS);
  });

  it('renders the documented soft20/warn50/buffer10, usage40, cache20 fixture', () => {
    // [###~====-!-|--------] 40%
    expect(renderBarLine(input({ usedPercent: 40, cachedPercent: 20 }))).toBe('[###~====-!-|--------] 40%');
  });

  it('renders 0% usage as all free with markers intact', () => {
    expect(renderBarCells(input({ usedPercent: 0, cachedPercent: 0 }))).toBe('---~-----!-|--------');
  });

  it('renders 100% usage as a full used bar with markers replacing cells', () => {
    // used fills all 20 cells; markers overwrite their cells.
    expect(renderBarLine(input({ usedPercent: 100, cachedPercent: 0 }))).toBe('[===~=====!=|========] 100%');
  });

  it('bounds cached cells by measured usage (cache cannot exceed used)', () => {
    // cache 80% but usage only 20%: at most 4 cached cells (= used); markers stay.
    const cells = renderBarCells(input({ usedPercent: 20, cachedPercent: 80 }));
    expect(cells).toBe('###~-----!-|--------');
  });

  it('labels unknown usage as ?% but keeps the markers', () => {
    const line = renderBarLine(input({ usedPercent: null, cachedPercent: null }));
    expect(line.endsWith('] ?%')).toBe(true);
    expect(line).toBe('[---~-----!-|--------] ?%');
  });

  it('places markers at 10/20/25% on a 1M window and keeps priority deterministic', () => {
    const cells = renderBarCells(
      input({ usedPercent: 0, cachedPercent: 0, softPercent: 10, warningPercent: 20, hardPercent: 25 }),
    );
    // ceil(10/5)-1=1 soft, ceil(20/5)-1=3 warning, ceil(25/5)-1=4 hard
    expect(cells[1]).toBe('~');
    expect(cells[3]).toBe('!');
    expect(cells[4]).toBe('|');
  });

  it('resolves default 1M markers (22.5/25/27%) with warning winning the soft collision', () => {
    // soft 22.5 -> ceil(4.5)-1 = 4; warning 25 -> ceil(5)-1 = 4 (collision, warning wins);
    // hard 27 -> ceil(5.4)-1 = 5.
    const cells = renderBarCells(
      input({ usedPercent: 0, cachedPercent: 0, softPercent: 22.5, warningPercent: 25, hardPercent: 27 }),
    );
    expect(cells[4]).toBe('!');
    expect(cells[5]).toBe('|');
    expect(cells).not.toContain('~'); // soft was overwritten by the warning collision
  });

  it('resolves a zero-buffer overlap (hard == warning) to the hard marker', () => {
    const cells = renderBarCells(
      input({ usedPercent: 0, cachedPercent: 0, softPercent: 20, warningPercent: 50, hardPercent: 50 }),
    );
    expect(cells[9]).toBe('|'); // hard wins over warning at the same cell
    expect(cells[3]).toBe('~');
  });
});

describe('latest cache calculation', () => {
  function assistantEntry(cacheRead: number): SessionEntry {
    const message = fauxAssistantMessage('ok');
    message.usage.cacheRead = cacheRead;
    return { type: 'message', message, id: 'a', parentId: null, timestamp: '' } as unknown as SessionEntry;
  }
  function compactionEntry(): SessionEntry {
    return {
      type: 'compaction',
      summary: 's',
      firstKeptEntryId: 'k',
      tokensBefore: 1,
      id: 'c',
      parentId: null,
      timestamp: '',
    } as unknown as SessionEntry;
  }

  it('returns the most recent assistant cacheRead', () => {
    expect(latestApplicableCacheRead([assistantEntry(100), assistantEntry(250)])).toBe(250);
  });

  it('invalidates the cached value after a more recent compaction boundary', () => {
    // A compaction after the last assistant response means the old cache no
    // longer describes the new prompt.
    expect(latestApplicableCacheRead([assistantEntry(250), compactionEntry()])).toBe(null);
  });

  it('returns the post-compaction assistant cacheRead once one exists', () => {
    expect(latestApplicableCacheRead([assistantEntry(250), compactionEntry(), assistantEntry(30)])).toBe(30);
  });

  it('returns null when there is no assistant usage yet', () => {
    expect(latestApplicableCacheRead([])).toBe(null);
  });
});

describe('context widget token wiring', () => {
  it('invalidates cached fills through contextBarLine after compaction (unknown usage)', () => {
    // tokens null right after compaction => ?% and no cached/used cells.
    const line = contextBarLine(
      { tokens: null, cachedTokens: 500 },
      { softTokens: 200000, warningTokens: 500000, hardTokens: 600000, contextWindow: 1_000_000 },
    );
    expect(line.endsWith('] ?%')).toBe(true);
  });
});
