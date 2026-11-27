import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFork } from './index.js';

const calls = vi.hoisted(() => [] as { cmd: string; args: string[] }[]);
let succeed: (cmd: string) => boolean = () => false;

// Record launches; never start tmux, Ghostty, or pbcopy.
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, ...rest: unknown[]) => {
    const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    const cb = rest.at(-1) as (err: Error | null) => void;
    calls.push({ cmd, args });
    cb(succeed(cmd) ? null : new Error('unavailable'));
    return { stdin: { end() {} } };
  },
}));

beforeEach(() => {
  calls.length = 0;
  succeed = () => false;
  vi.stubEnv('TMUX', '');
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
});
afterEach(() => vi.unstubAllEnvs());

it('passes a non-default agent dir to the tmux split', async () => {
  vi.stubEnv('TMUX', '/tmp/tmux-1/default,1,0');
  vi.stubEnv('PI_CODING_AGENT_DIR', '/home/me/.pi/work');
  succeed = (cmd) => cmd === 'tmux';

  await openFork('/s/fork.jsonl', '/repo');

  expect(calls[0]!.args).toEqual(
    expect.arrayContaining(['-e', 'PI_CODING_AGENT_DIR=/home/me/.pi/work', 'pi', '--session', '/s/fork.jsonl']),
  );
  expect(calls[0]!.args.indexOf('-e')).toBeLessThan(calls[0]!.args.indexOf('pi'));
});

it('passes a non-default agent dir to the new Ghostty window', async () => {
  if (process.platform !== 'darwin') return; // the Ghostty path is macOS-only
  vi.stubEnv('PI_CODING_AGENT_DIR', '/home/me/.pi/work');
  succeed = (cmd) => cmd === 'open';

  await openFork('/s/fork.jsonl', '/repo');

  const args = calls.find((c) => c.cmd === 'open')!.args;
  expect(args.slice(-5)).toEqual([
    '-ilc',
    'PI_CODING_AGENT_DIR="$2" exec pi --session "$1"',
    'btw',
    '/s/fork.jsonl',
    '/home/me/.pi/work',
  ]);
});

it('puts a non-default agent dir in the printed command', async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', "/home/me/it's");

  expect(await openFork('/s/fork.jsonl', '/repo')).toBe(
    `btw fork ready: PI_CODING_AGENT_DIR='/home/me/it'\\''s' pi --session '/s/fork.jsonl'`,
  );
});

it('leaves the commands unchanged with the default agent dir', async () => {
  vi.stubEnv('TMUX', '/tmp/tmux-1/default,1,0');
  succeed = (cmd) => cmd === 'tmux';
  await openFork('/s/fork.jsonl', '/repo');
  expect(calls[0]!.args).not.toContain('-e');

  succeed = () => false;
  expect(await openFork('/s/fork.jsonl', '/repo')).toBe(`btw fork ready: pi --session '/s/fork.jsonl'`);
});
