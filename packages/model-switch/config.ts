import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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

  return parseModelSwitchConfig(value, path);
}

function parseModelSwitchConfig(value: unknown, path: string): ConfigLoadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `Invalid model-switch config at ${path}: expected an object` };
  }

  const obj = value as Record<string, unknown>;

  // Prefer "sections" if present; fall back to legacy "models" as a single section.
  if ('sections' in obj) {
    if (!obj.sections || typeof obj.sections !== 'object' || Array.isArray(obj.sections)) {
      return { ok: false, error: `Invalid model-switch config at ${path}: expected "sections" to be an object` };
    }
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

export function addModelToSection(
  reference: string,
  sectionName: string,
  path = modelCycleConfigPath(),
): { ok: true; added: boolean } | { ok: false; error: string } {
  try {
    // Read again after the dialogs so edits made while they were open are retained.
    const existing = lstatSync(path, { throwIfNoEntry: false });
    const target = existing ? realpathSync(path) : path;
    const value = existing ? JSON.parse(readFileSync(target, 'utf8')) : { sections: { [sectionName]: [] } };
    const loaded = parseModelSwitchConfig(value, path);
    if (!loaded.ok) return loaded;

    const section = loaded.config.sections.find((item) => item.name === sectionName);
    if (!section) {
      return { ok: false, error: `Section "${sectionName}" no longer exists in ${path}` };
    }
    if (section.models.includes(reference)) return { ok: true, added: false };

    const models: string[] = 'sections' in value ? value.sections[sectionName] : value.models;
    models.push(reference);

    // Replace the file atomically, following config symlinks rather than replacing them.
    mkdirSync(dirname(target), { recursive: true });
    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        flag: 'wx',
        mode: existing ? statSync(target).mode & 0o777 : 0o600,
      });
      renameSync(temporaryPath, target);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    return { ok: true, added: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not update model-switch config at ${path}: ${message}` };
  }
}
