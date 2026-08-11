import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface ModelSwitchSection {
  name: string;
  models: string[];
}

export interface ModelSwitchConfig {
  sections: ModelSwitchSection[];
}

export interface ModelSwitchKeybindings {
  forward: string;
  backward: string;
  select: string;
}

export const DEFAULT_MODEL_CYCLE_KEYBINDINGS: ModelSwitchKeybindings = {
  forward: 'ctrl+shift+m',
  backward: 'ctrl+shift+alt+m',
  select: 'ctrl+shift+l',
};

const FORWARD_KEYBINDING = 'model-switch.cycleForward';
const BACKWARD_KEYBINDING = 'model-switch.cycleBackward';
const SELECT_KEYBINDING = 'model-switch.select';

export type ConfigLoadResult = { ok: true; config: ModelSwitchConfig } | { ok: false; error: string };

export function modelCycleConfigPath(): string {
  return join(getAgentDir(), 'configs', 'model-switch.json');
}

export function modelCycleKeybindingsPath(): string {
  return join(getAgentDir(), 'keybindings.json');
}

export function loadModelSwitchKeybindings(path = modelCycleKeybindingsPath()): ModelSwitchKeybindings {
  if (!existsSync(path)) return { ...DEFAULT_MODEL_CYCLE_KEYBINDINGS };

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ...DEFAULT_MODEL_CYCLE_KEYBINDINGS };
  }

  if (!value || typeof value !== 'object') return { ...DEFAULT_MODEL_CYCLE_KEYBINDINGS };

  const bindings = value as Record<string, unknown>;
  const forward = bindings[FORWARD_KEYBINDING];
  const backward = bindings[BACKWARD_KEYBINDING];
  const select = bindings[SELECT_KEYBINDING];

  return {
    forward:
      typeof forward === 'string' && forward.trim().length > 0
        ? forward.trim()
        : DEFAULT_MODEL_CYCLE_KEYBINDINGS.forward,
    backward:
      typeof backward === 'string' && backward.trim().length > 0
        ? backward.trim()
        : DEFAULT_MODEL_CYCLE_KEYBINDINGS.backward,
    select:
      typeof select === 'string' && select.trim().length > 0 ? select.trim() : DEFAULT_MODEL_CYCLE_KEYBINDINGS.select,
  };
}

function validateModelStrings(raw: unknown, path: string, context: string): string[] | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: `Invalid model-switch config at ${path}: expected "${context}" to be a string[]` };
  }
  if (raw.some((model) => typeof model !== 'string' || model.trim().length === 0)) {
    return { error: `Invalid model-switch config at ${path}: every model in "${context}" must be a non-empty string` };
  }
  return raw.map((model) => model.trim());
}

export function loadModelSwitchConfig(path = modelCycleConfigPath()): ConfigLoadResult {
  if (!existsSync(path)) {
    return { ok: true, config: { sections: [] } };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid model-switch config at ${path}: ${message}` };
  }

  if (!value || typeof value !== 'object') {
    return { ok: false, error: `Invalid model-switch config at ${path}: expected an object` };
  }

  const obj = value as Record<string, unknown>;

  // Prefer "sections" if present; fall back to legacy "models" as a single section.
  if ('sections' in obj && obj.sections && typeof obj.sections === 'object') {
    const sectionsRaw = obj.sections as Record<string, unknown>;
    const sections: ModelSwitchSection[] = [];

    for (const [name, modelsRaw] of Object.entries(sectionsRaw)) {
      const result = validateModelStrings(modelsRaw, path, `sections.${name}`);
      if (!Array.isArray(result)) return { ok: false, error: result.error };
      sections.push({ name, models: result });
    }

    if (sections.length === 0) {
      return {
        ok: false,
        error: `Invalid model-switch config at ${path}: "sections" must define at least one section`,
      };
    }

    return { ok: true, config: { sections } };
  }

  if ('models' in obj) {
    const result = validateModelStrings(obj.models, path, 'models');
    if (!Array.isArray(result)) return { ok: false, error: result.error };
    return { ok: true, config: { sections: [{ name: 'models', models: result }] } };
  }

  return {
    ok: false,
    error: `Invalid model-switch config at ${path}: expected { "sections": { ... } } or { "models": [...] }`,
  };
}
