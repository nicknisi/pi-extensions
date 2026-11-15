import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/** Choose an available optional chat model, otherwise the current session model. */
export async function selectSideModel(
  ctx: Pick<ExtensionContext, 'model' | 'modelRegistry'>,
  preferences: readonly string[],
  signal?: AbortSignal,
): Promise<ExtensionContext['model']> {
  for (const preference of preferences) {
    if (signal?.aborted) return undefined;
    const slash = preference.indexOf('/');
    if (slash <= 0 || slash === preference.length - 1 || /\s/.test(preference)) continue;
    const provider = preference.slice(0, slash);
    const id = preference.slice(slash + 1);
    try {
      const available = await ctx.modelRegistry.getAvailableOfType('chat', provider, signal ? { signal } : {});
      if (signal?.aborted) return undefined;
      const model = available.find((model) => model.provider === provider && model.id === id);
      if (model) return model;
    } catch {
      // Credential discovery can fail for one provider without blocking the next.
    }
  }
  return signal?.aborted ? undefined : ctx.model;
}
