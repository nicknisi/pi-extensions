// Reports pi session status to the SidePulse daemon, like its Claude Code / Codex hooks do.
// working while the agent runs, blocked while a UI prompt waits on you, done when it settles.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const BIN = join(homedir(), '.local/bin/sidepulse');

export default function (pi: ExtensionAPI) {
  let queue: Promise<void> = Promise.resolve();
  let base = 'idle'; // state to return to after a prompt closes

  function report(ctx: ExtensionContext, state: string, extra: string[] = []) {
    if (!ctx.hasUI) return; // skip `pi -p` one-shots so they don't leave stale sessions
    const sm = ctx.sessionManager;
    const args = [
      'report',
      '--scope',
      `pi-${sm.getSessionId()}`,
      '--state',
      state,
      '--app',
      'pi',
      '--title',
      sm.getSessionName() || basename(ctx.cwd) || 'pi',
      ...extra,
    ];
    // Serialized so a quick working -> blocked pair can't land out of order. Errors (no daemon) are ignored.
    queue = queue.then(() => new Promise((resolve) => execFile(BIN, args, { timeout: 3000 }, () => resolve())));
    return queue;
  }

  pi.on('session_start', (_e, ctx) => {
    base = 'idle';
    report(ctx, base);
  });
  pi.on('agent_start', (_e, ctx) => {
    base = 'working';
    report(ctx, base);
  });
  pi.on('agent_settled', (e, ctx) => {
    base = e.aborted ? 'idle' : 'done';
    report(ctx, base);
  });
  pi.on('ui_prompt_start', (e, ctx) => {
    report(ctx, 'blocked', [
      '--kind',
      e.kind === 'confirm' ? 'permission' : 'question',
      ...(e.title ? ['--msg', e.title] : []),
    ]);
  });
  pi.on('ui_prompt_end', (_e, ctx) => {
    report(ctx, base);
  });
  pi.on('session_shutdown', (_e, ctx) => report(ctx, 'clear'));
}
