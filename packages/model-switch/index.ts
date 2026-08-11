import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SelectItem } from '@earendil-works/pi-tui';
import { loadModelSwitchConfig, loadModelSwitchKeybindings, modelCycleConfigPath } from './config.js';
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
    description: 'Select from configured models',
    handler: async (_args, ctx) => showModelPicker(pi, ctx),
  });
}
