import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Audio is gated to macOS; pretend we're on it so the spawn paths run everywhere.
const realPlatform = vi.hoisted(() => {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  return real;
});

const spawned = vi.hoisted(() => [] as { cmd: string; args: string[]; proc: import('node:events').EventEmitter }[]);
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    const proc = Object.assign(new EventEmitter(), { killed: false, kill: () => true });
    spawned.push({ cmd, args, proc });
    return proc;
  },
}));

const { playClick, speak } = await import('./sound.js');

afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform }));
beforeEach(() => {
  spawned.length = 0;
});

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

describe('sound spawn failures', () => {
  it('handles a missing afplay without throwing and removes the temp WAV', () => {
    expect(playClick()).not.toBeNull();
    const { cmd, args, proc } = spawned[0]!;
    expect(cmd).toBe('afplay');
    expect(existsSync(args[0]!)).toBe(true);
    // An 'error' with no listener would throw here (and crash pi in production).
    expect(() => proc.emit('error', enoent())).not.toThrow();
    expect(existsSync(args[0]!)).toBe(false);
  });

  it('handles a missing say without throwing and does not report speech as done', () => {
    const onDone = vi.fn();
    speak('hello', 120, onDone);
    const { cmd, proc } = spawned[0]!;
    expect(cmd).toBe('say');
    expect(() => proc.emit('error', enoent())).not.toThrow();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reports speech as done when say exits', () => {
    const onDone = vi.fn();
    speak('hello', 120, onDone);
    spawned[0]!.proc.emit('exit', 0, null);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('does not report speech as done when say fails or is killed', () => {
    const onDone = vi.fn();
    speak('hello', 120, onDone);
    spawned[0]!.proc.emit('exit', 1, null);
    speak('hello', 120, onDone);
    spawned[1]!.proc.emit('exit', null, 'SIGKILL');
    expect(onDone).not.toHaveBeenCalled();
  });
});
