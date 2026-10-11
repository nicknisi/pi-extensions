import { afterEach, describe, expect, it, vi } from 'vitest';
import turnTimer from './index.js';

afterEach(() => vi.useRealTimers());

function harness() {
  const handlers = new Map<string, (event: any) => void>();
  const appendEntry = vi.fn();
  turnTimer({
    registerEntryRenderer: () => {},
    on: (name: string, fn: (event: any) => void) => handlers.set(name, fn),
    appendEntry,
  } as never);
  const emit = (name: string, event: object = {}) => handlers.get(name)!(event);
  return { emit, appendEntry };
}

describe('turn-timer', () => {
  it('leaves out time spent on ui prompts and labels aborted runs', () => {
    vi.useFakeTimers();
    const { emit, appendEntry } = harness();
    emit('agent_start');
    vi.advanceTimersByTime(2000);
    emit('ui_prompt_start');
    vi.advanceTimersByTime(10_000);
    emit('ui_prompt_end');
    vi.advanceTimersByTime(1000);
    emit('agent_settled', { aborted: false });
    expect(appendEntry).toHaveBeenLastCalledWith('turn-duration', { seconds: 3 });

    emit('agent_start');
    vi.advanceTimersByTime(500);
    emit('agent_settled', { aborted: true });
    expect(appendEntry).toHaveBeenLastCalledWith('turn-duration', { seconds: 0.5, aborted: true });
  });
});
