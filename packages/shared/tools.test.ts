import { describe, expect, it, vi } from 'vitest';
import { declareUnlessSearchable } from './tools.js';

function api(active: string[]) {
  return { getActiveTools: () => active, setActiveTools: vi.fn() };
}

describe('declareUnlessSearchable', () => {
  it('declares missing tools when tool_search is not active', () => {
    const pi = api(['read', 'a']);
    declareUnlessSearchable(pi, ['a', 'b']);
    expect(pi.setActiveTools).toHaveBeenCalledWith(['read', 'a', 'b']);
  });

  it('leaves tools deferred when tool_search is active, and does nothing when all are declared', () => {
    const searchable = api(['tool_search']);
    declareUnlessSearchable(searchable, ['a']);
    const declared = api(['a']);
    declareUnlessSearchable(declared, ['a']);
    expect(searchable.setActiveTools).not.toHaveBeenCalled();
    expect(declared.setActiveTools).not.toHaveBeenCalled();
  });
});
