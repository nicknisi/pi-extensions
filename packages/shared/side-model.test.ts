import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { selectSideModel } from './side-model.js';

describe('selectSideModel', () => {
  const current = { provider: 'session', id: 'current' };
  const preferred = { provider: 'remote', id: 'org/model' };
  function harness() {
    const getAvailableOfType = vi.fn().mockResolvedValue([]);
    const ctx = { model: current, modelRegistry: { getAvailableOfType } } as unknown as ExtensionContext;
    return { ctx, getAvailableOfType };
  }

  it('checks exact preferences in order, including slash IDs, skipping unavailable catalog entries', async () => {
    const { ctx, getAvailableOfType } = harness();
    getAvailableOfType.mockResolvedValueOnce([]).mockResolvedValueOnce([preferred]);
    expect(
      await selectSideModel(ctx, [
        'bad',
        '/bad',
        'bad/',
        'bad provider/model',
        'remote/ ',
        'missing/model',
        'remote/org/model',
        'later/model',
      ]),
    ).toBe(preferred);
    expect(getAvailableOfType.mock.calls).toEqual([
      ['chat', 'missing', {}],
      ['chat', 'remote', {}],
    ]);
  });

  it('continues after lookup failures and re-reads the current model at fallback time', async () => {
    const { ctx, getAvailableOfType } = harness();
    const changed = { ...current, id: 'changed' } as ExtensionContext['model'];
    getAvailableOfType.mockImplementation(async () => {
      ctx.model = changed;
      throw new Error('credentials unavailable');
    });
    expect(await selectSideModel(ctx, ['remote/model'])).toBe(changed);
    ctx.model = undefined;
    expect(await selectSideModel(ctx, [])).toBeUndefined();
    expect(getAvailableOfType).toHaveBeenCalledTimes(1);
  });

  it('continues to a usable preference after a rejected lookup, even without a current model', async () => {
    const { ctx, getAvailableOfType } = harness();
    ctx.model = undefined;
    getAvailableOfType.mockRejectedValueOnce(new Error('auth lookup failed')).mockResolvedValueOnce([preferred]);
    expect(await selectSideModel(ctx, ['broken/model', 'remote/org/model'])).toBe(preferred);
    expect(getAvailableOfType).toHaveBeenCalledTimes(2);
  });

  it('does not check providers with no preferences, and does not cache fallback', async () => {
    const { ctx, getAvailableOfType } = harness();
    expect(await selectSideModel(ctx, [])).toBe(current);
    ctx.model = { ...current, id: 'changed' } as ExtensionContext['model'];
    expect(await selectSideModel(ctx, [])).toBe(ctx.model);
    expect(getAvailableOfType).not.toHaveBeenCalled();
  });

  it('returns undefined on abort before or during lookup, never falling back', async () => {
    const { ctx, getAvailableOfType } = harness();
    const controller = new AbortController();
    getAvailableOfType.mockImplementation(async () => {
      controller.abort();
      return [preferred];
    });
    expect(await selectSideModel(ctx, ['remote/org/model', 'other/model'], controller.signal)).toBeUndefined();
    expect(getAvailableOfType).toHaveBeenCalledWith('chat', 'remote', { signal: controller.signal });
    expect(await selectSideModel(ctx, [], controller.signal)).toBeUndefined();
    expect(await selectSideModel(ctx, ['remote/org/model'], controller.signal)).toBeUndefined();
    expect(getAvailableOfType).toHaveBeenCalledTimes(1);
  });
});
