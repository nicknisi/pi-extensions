import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasUltracodeKeyword, ultracodeDefault } from './ultracode.js';

describe('hasUltracodeKeyword', () => {
  it.each([
    ['ultracode: audit every route for missing auth', true],
    ['please ULTRACODE this migration', true],
    ['run it (ultracode).', true],
    ['the ultracode-keyword setting', false],
    ['myultracode', false],
    ['/ultracode on', false],
    ['just fix the typo', false],
  ])('%s → %s', (text, expected) => {
    expect(hasUltracodeKeyword(text)).toBe(expected);
  });
});

describe('ultracodeDefault', () => {
  it('reads configs/workflows.json and defaults to off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ultracode-'));
    try {
      expect(ultracodeDefault(dir)).toBe(false);
      fs.mkdirSync(path.join(dir, 'configs'));
      fs.writeFileSync(path.join(dir, 'configs', 'workflows.json'), '{ "ultracode": true }');
      expect(ultracodeDefault(dir)).toBe(true);
      fs.writeFileSync(path.join(dir, 'configs', 'workflows.json'), 'not json');
      expect(ultracodeDefault(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
