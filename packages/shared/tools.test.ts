import { describe, expect, it, vi } from 'vitest';
import { declareUnlessSearchable } from './tools.js';

function api(active: string[], registered = ['read', 'tool_search', 'a', 'b']) {
  return {
    getActiveTools: () => active,
    getAllTools: () => registered.map((name) => ({ name })) as never,
    setActiveTools: vi.fn(),
  };
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

  it('never re-enables a tool an explicit allowlist or exclusion removed from the registry', () => {
    // `--tools read` / `--exclude-tools b`: pi drops unnamed extension tools from getAllTools().
    const restricted = api(['read'], ['read']);
    declareUnlessSearchable(restricted, ['a', 'b']);
    const excluded = api(['read'], ['read', 'a']);
    declareUnlessSearchable(excluded, ['a', 'b']);
    expect(restricted.setActiveTools).not.toHaveBeenCalled();
    expect(excluded.setActiveTools).toHaveBeenCalledWith(['read', 'a']);
  });
});
