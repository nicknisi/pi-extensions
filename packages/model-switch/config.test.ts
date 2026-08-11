import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL_CYCLE_KEYBINDINGS, loadModelSwitchConfig, loadModelSwitchKeybindings } from './config.js';

const tempDirs: string[] = [];

function tempConfig(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-switch-'));
  tempDirs.push(dir);
  const path = join(dir, 'model-switch.json');
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

afterEach(() => {
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
