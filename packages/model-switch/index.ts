import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SelectItem } from '@earendil-works/pi-tui';
import {
  addModelToSection,
  loadModelSwitchConfig,
  loadModelSwitchKeybindings,
  modelCycleConfigPath,
} from './config.js';
import { findActiveSection, resolveAvailableModels, selectCycleTarget, type CycleDirection } from './cycle.js';
import { SectionPicker, type PickerSection } from './section-picker.js';

async function resolveSectionModels(references: readonly string[], ctx: ExtensionContext): Promise<Model<Api>[]> {
  return resolveAvailableModels(references, ctx.modelRegistry);
}

async function switchModel(pi: ExtensionAPI, ctx: ExtensionContext, target: Model<Api>): Promise<void> {
  if (!(await pi.setModel(target))) {
    ctx.ui.notify(`Could not switch to ${target.provider}/${target.id}`, 'warning');
  }
}

async function cycleConfiguredModel(pi: ExtensionAPI, ctx: ExtensionContext, direction: CycleDirection): Promise<void> {
  const loaded = loadModelSwitchConfig();
  if (!loaded.ok) {
    ctx.ui.notify(loaded.error, 'warning');
    return;
  }

  const activeSection = findActiveSection(loaded.config.sections, ctx.model);
  if (!activeSection) {
    ctx.ui.notify(`No configured models are available in ${modelCycleConfigPath()}`, 'warning');
    return;
  }

  const available = await resolveSectionModels(activeSection.models, ctx);
  if (available.length === 0) {
    ctx.ui.notify(`No usable models in section "${activeSection.name}" (${modelCycleConfigPath()})`, 'warning');
    return;
  }

  const target = selectCycleTarget(ctx.model, available, direction);
  if (target) await switchModel(pi, ctx, target);
}

function buildSectionItems(models: Model<Api>[], current: Model<Api> | undefined): SelectItem[] {
  return models.map((model) => {
    const isCurrent = model.provider === current?.provider && model.id === current.id;
    return {
      value: `${model.provider}/${model.id}`,
      label: `${isCurrent ? '●' : ' '} ${model.provider}/${model.id}`,
    };
  });
}

async function showModelPicker(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const loaded = loadModelSwitchConfig();
  if (!loaded.ok) {
    ctx.ui.notify(loaded.error, 'warning');
    return;
  }

  const pickerSections: PickerSection[] = [];
  const modelByReference = new Map<string, Model<Api>>();

  for (const section of loaded.config.sections) {
    const available = await resolveSectionModels(section.models, ctx);
    if (available.length > 0) {
      pickerSections.push({
        name: section.name,
        items: buildSectionItems(available, ctx.model),
      });
      for (const model of available) {
        modelByReference.set(`${model.provider}/${model.id}`, model);
      }
    }
  }

  if (pickerSections.length === 0) {
    ctx.ui.notify(`No configured models are available in ${modelCycleConfigPath()}`, 'warning');
    return;
  }

  const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    return new SectionPicker(pickerSections, theme, done);
  });

  if (!selected) return;

  const target = modelByReference.get(selected);
  if (target) await switchModel(pi, ctx, target);
}

async function addConfiguredModel(ctx: ExtensionContext, useCurrent: boolean): Promise<void> {
  if (!ctx.hasUI) return;
  if (!useCurrent && ctx.mode !== 'tui') {
    ctx.ui.notify('/model-switch add requires the terminal UI', 'warning');
    return;
  }

  const loaded = loadModelSwitchConfig();
  if (!loaded.ok) {
    ctx.ui.notify(loaded.error, 'warning');
    return;
  }

  let target = ctx.model;
  if (!useCurrent) {
    const available = ctx.modelRegistry.getAvailable();
    if (available.length === 0) {
      ctx.ui.notify('No available models to add. Configure a provider with /login first.', 'warning');
      return;
    }
    const selected = await ctx.ui.custom<string | null>((_tui, theme, _keybindings, done) => {
      return new SectionPicker([{ name: 'Add a model', items: buildSectionItems(available, ctx.model) }], theme, done);
    });
    if (!selected) return;
    target = available.find((model) => `${model.provider}/${model.id}` === selected);
  }
  if (!target) {
    ctx.ui.notify('No model selected to add', 'warning');
    return;
  }

  const reference = `${target.provider}/${target.id}`;
  const sections = loaded.config.sections.map((section) => section.name);
  const sectionName =
    sections.length > 0
      ? await ctx.ui.select(`Add ${reference} to section`, sections)
      : (await ctx.ui.input('Name your first model-switch section', 'models'))?.trim();
  if (sectionName === undefined) return;
  if (sections.length === 0 && !sectionName) {
    ctx.ui.notify('Section name must not be empty', 'warning');
    return;
  }

  const result = addModelToSection(reference, sectionName);
  if (!result.ok) {
    ctx.ui.notify(result.error, 'warning');
    return;
  }
  ctx.ui.notify(
    result.added ? `Added ${reference} to "${sectionName}"` : `${reference} is already in "${sectionName}"`,
    'info',
  );
}

export default function modelCycle(pi: ExtensionAPI) {
  const keybindings = loadModelSwitchKeybindings();
  type ShortcutKey = Parameters<ExtensionAPI['registerShortcut']>[0];

  pi.registerShortcut(keybindings.forward as ShortcutKey, {
    description: 'Cycle configured models forward',
    handler: async (ctx) => cycleConfiguredModel(pi, ctx, 'forward'),
  });

  pi.registerShortcut(keybindings.backward as ShortcutKey, {
    description: 'Cycle configured models backward',
    handler: async (ctx) => cycleConfiguredModel(pi, ctx, 'backward'),
  });

  pi.registerShortcut(keybindings.select as ShortcutKey, {
    description: 'Select a configured model',
    handler: async (ctx) => showModelPicker(pi, ctx),
  });

  pi.registerCommand('model-switch', {
    description: 'Select configured models, add a model, or add-current',
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: 'add', label: 'add', description: 'Pick an available model to save' },
        { value: 'add-current', label: 'add-current', description: 'Save the current model' },
      ].filter((item) => item.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      switch (args.trim()) {
        case '':
          return showModelPicker(pi, ctx);
        case 'add':
          return addConfiguredModel(ctx, false);
        case 'add-current':
          return addConfiguredModel(ctx, true);
        default:
          ctx.ui.notify('Usage: /model-switch [add | add-current]', 'warning');
      }
    },
  });
}
