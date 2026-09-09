import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addModelToSection,
  DEFAULT_MODEL_CYCLE_KEYBINDINGS,
  loadModelSwitchConfig,
  loadModelSwitchKeybindings,
} from './config.js';

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()) }));

const tempDirs: string[] = [];

function tempConfig(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-switch-'));
  tempDirs.push(dir);
  const path = join(dir, 'model-switch.json');
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadModelSwitchKeybindings', () => {
  it('uses defaults when keybindings.json is missing or malformed', () => {
    expect(loadModelSwitchKeybindings(tempConfig())).toEqual(DEFAULT_MODEL_CYCLE_KEYBINDINGS);
    expect(loadModelSwitchKeybindings(tempConfig('{ nope'))).toEqual(DEFAULT_MODEL_CYCLE_KEYBINDINGS);
  });

  it('loads extension-owned bindings from keybindings.json', () => {
    const result = loadModelSwitchKeybindings(
      tempConfig(
        JSON.stringify({
          'model-switch.cycleForward': 'ctrl+alt+n',
          'model-switch.cycleBackward': 'ctrl+alt+b',
          'model-switch.select': 'ctrl+alt+l',
          'app.model.select': 'ctrl+l',
        }),
      ),
    );

    expect(result).toEqual({
      forward: 'ctrl+alt+n',
      backward: 'ctrl+alt+b',
      select: 'ctrl+alt+l',
    });
  });

  it('falls back per binding when extension-owned values are absent or invalid', () => {
    const result = loadModelSwitchKeybindings(
      tempConfig(
        JSON.stringify({
          'model-switch.cycleForward': [],
          'model-switch.cycleBackward': ' ctrl+alt+b ',
        }),
      ),
    );

    expect(result).toEqual({
      forward: DEFAULT_MODEL_CYCLE_KEYBINDINGS.forward,
      backward: 'ctrl+alt+b',
      select: DEFAULT_MODEL_CYCLE_KEYBINDINGS.select,
    });
  });
});

describe('loadModelSwitchConfig', () => {
  it('returns empty sections when the config is missing', () => {
    const result = loadModelSwitchConfig(tempConfig());

    expect(result).toEqual({ ok: true, config: { sections: [] } });
  });

  it('loads named sections in order', () => {
    const result = loadModelSwitchConfig(
      tempConfig(
        JSON.stringify({
          sections: {
            work: ['cloudflare-ai-gateway/grok-4.5', '  fireworks/.../kimi-k3  '],
            personal: ['fireworks/.../kimi-k3'],
          },
        }),
      ),
    );

    expect(result).toEqual({
      ok: true,
      config: {
        sections: [
          { name: 'work', models: ['cloudflare-ai-gateway/grok-4.5', 'fireworks/.../kimi-k3'] },
          { name: 'personal', models: ['fireworks/.../kimi-k3'] },
        ],
      },
    });
  });

  it('falls back to legacy flat models as a single section', () => {
    const result = loadModelSwitchConfig(tempConfig(JSON.stringify({ models: ['cloudflare-ai-gateway/grok-4.5'] })));

    expect(result).toEqual({
      ok: true,
      config: { sections: [{ name: 'models', models: ['cloudflare-ai-gateway/grok-4.5'] }] },
    });
  });

  it('prefers sections when both sections and models are present', () => {
    const result = loadModelSwitchConfig(
      tempConfig(
        JSON.stringify({
          sections: { work: ['provider/model-a'] },
          models: ['provider/model-b'],
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.sections).toEqual([{ name: 'work', models: ['provider/model-a'] }]);
  });

  it('reports malformed JSON with the config path', () => {
    const path = tempConfig('{ nope');
    const result = loadModelSwitchConfig(path);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(path);
      expect(result.error).toContain('Invalid model-switch config');
    }
  });

  it.each([
    ['non-object input', '[]'],
    ['missing sections and models', '{}'],
    ['non-object sections', JSON.stringify({ sections: 'nope' })],
    ['empty sections object', JSON.stringify({ sections: {} })],
    ['array sections', JSON.stringify({ sections: [['provider/model']] })],
    ['invalid sections with legacy models', JSON.stringify({ sections: null, models: ['provider/model'] })],
    ['non-array section models', JSON.stringify({ sections: { work: 'nope' } })],
    ['non-string model in section', JSON.stringify({ sections: { work: [42] } })],
    ['empty model in section', JSON.stringify({ sections: { work: ['  '] } })],
    ['non-array legacy models', JSON.stringify({ models: 'grok-4.5' })],
  ])('rejects %s', (_label, content) => {
    const path = tempConfig(content);
    const result = loadModelSwitchConfig(path);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(path);
  });
});

describe('addModelToSection', () => {
  it('appends only to the selected section and preserves other config fields', () => {
    const config = {
      sections: { work: ['provider/old'], personal: ['provider/new'] },
      models: ['legacy/ignored'],
      note: 'keep me',
    };
    const path = tempConfig(JSON.stringify(config));

    expect(addModelToSection('provider/new', 'work', path)).toEqual({ ok: true, added: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      ...config,
      sections: { work: ['provider/old', 'provider/new'], personal: ['provider/new'] },
    });
  });

  it('does not rewrite a duplicate, including a whitespace-padded reference', () => {
    const content = '{ "sections": { "work": [" provider/model "] } }';
    const path = tempConfig(content);

    expect(addModelToSection('provider/model', 'work', path)).toEqual({ ok: true, added: false });
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('keeps the legacy flat format', () => {
    const path = tempConfig(JSON.stringify({ models: ['provider/old'], note: 'keep' }));

    expect(addModelToSection('provider/new', 'models', path)).toEqual({ ok: true, added: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      models: ['provider/old', 'provider/new'],
      note: 'keep',
    });
  });

  it('creates missing config directories and preserves slashes in model IDs', () => {
    const path = join(tempConfig(), 'configs', 'model-switch.json');

    expect(addModelToSection('fireworks/accounts/fireworks/models/kimi-k3', 'personal', path)).toEqual({
      ok: true,
      added: true,
    });
    expect(loadModelSwitchConfig(path)).toEqual({
      ok: true,
      config: { sections: [{ name: 'personal', models: ['fireworks/accounts/fireworks/models/kimi-k3'] }] },
    });
  });

  it('supports section names that match object prototype properties', () => {
    const path = tempConfig();

    expect(addModelToSection('provider/model', '__proto__', path)).toEqual({ ok: true, added: true });
    expect(loadModelSwitchConfig(path)).toEqual({
      ok: true,
      config: { sections: [{ name: '__proto__', models: ['provider/model'] }] },
    });
  });

  it.each(['{ nope', '{"sections":null,"models":[]}', '{"sections":[[]]}', '{"sections":{"work":[42]}}'])(
    'does not overwrite malformed config: %s',
    (content) => {
      const path = tempConfig(content);
      const result = addModelToSection('provider/new', 'work', path);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(path);
      expect(readFileSync(path, 'utf8')).toBe(content);
    },
  );

  it('does not recreate a section removed while the picker was open', () => {
    const content = '{"sections":{"personal":[]}}';
    const path = tempConfig(content);

    expect(addModelToSection('provider/new', 'work', path)).toEqual({
      ok: false,
      error: `Section "work" no longer exists in ${path}`,
    });
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('updates a symlink target without replacing the link', () => {
    const path = tempConfig('{"sections":{"work":[]}}');
    const link = `${path}.link`;
    symlinkSync(path, link);

    expect(addModelToSection('provider/new', 'work', link)).toEqual({ ok: true, added: true });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ sections: { work: ['provider/new'] } });
  });

  it('does not replace a dangling config symlink', () => {
    const path = tempConfig();
    const link = `${path}.link`;
    symlinkSync(path, link);

    expect(addModelToSection('provider/new', 'work', link).ok).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('preserves the original config and cleans up when replacing the file fails', () => {
    const content = '{"sections":{"work":[]}}';
    const path = tempConfig(content);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk error');
    });

    expect(addModelToSection('provider/new', 'work', path)).toEqual({
      ok: false,
      error: `Could not update model-switch config at ${path}: disk error`,
    });
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(readdirSync(join(path, '..'))).toEqual(['model-switch.json']);
  });
});
