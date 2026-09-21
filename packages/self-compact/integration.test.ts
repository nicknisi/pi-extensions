import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, uuidv7, type AssistantMessage } from '@earendil-works/pi-ai';
import {
  createFixture,
  fauxToolCall,
  waitFor,
  type FixtureOptions,
  type SessionEntry,
} from './verify/fixture-provider.js';
import { runCli } from './verify/cli-runner.js';
import { readDeliveredCycleIds, readHandoffState, STATE_ENTRY } from './extensions/self-compact/self-compact.js';
import { loadDefaultCompactionInstruction } from './extensions/self-compact/prompts.js';

const NOTE = 'Finish the task: write result.txt containing exactly done.';

/** Ordered phases of every persisted handoff-state entry on the branch. */
function statePhases(entries: SessionEntry[]): string[] {
  return entries
    .filter(
      (e): e is SessionEntry & { customType: string; data: { phase: string } } =>
        e.type === 'custom' && (e as { customType?: unknown }).customType === STATE_ENTRY,
    )
    .map((e) => e.data.phase);
}

/** Count of real compaction entries on the branch. */
function compactionCount(entries: SessionEntry[]): number {
  return entries.filter((e) => e.type === 'compaction').length;
}

/** A scripted assistant summary response, as would come from the model. */
function summary(text = '## Goal\nWrite result.txt.\n\n## Next Steps\n1. Write result.txt with done.') {
  return fauxAssistantMessage(text);
}

/** A filler working turn so the later compaction has a prior turn to summarize. */
function fillerTurn() {
  return fauxAssistantMessage(fauxToolCall('bash', { command: 'echo working on the long task' }));
}

/** Inject a provider failure into the summarization request. */
const failingSummary = (() => {
  throw new Error('injected summary failure');
}) as never;

async function withFixture<T>(
  options: FixtureOptions,
  fn: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<T>,
) {
  const fixture = await createFixture(options);
  try {
    return await fn(fixture);
  } finally {
    fixture.dispose();
  }
}

describe('handoff lifecycle', () => {
  it('compacts once idle then resumes unfinished work via one continuation, restoring tools', async () => {
    await withFixture(
      {
        responses: [
          fillerTurn(),
          fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE })),
          summary(),
          fauxAssistantMessage(fauxToolCall('write', { path: 'result.txt', content: 'done' })),
          fauxAssistantMessage('Done.'),
        ],
      },
      async (fixture) => {
        const resultPath = join(fixture.dir, 'result.txt');
        await fixture.session.prompt('Begin the long task.');
        await waitFor(() => existsSync(resultPath), 20000);

        expect(readFileSync(resultPath, 'utf8')).toBe('done');

        const state = readHandoffState(fixture.branch());
        expect(state?.phase).toBe('delivered');
        expect(state?.note).toBe(NOTE);
        expect(state?.completedCycles).toBe(1);
        expect(readDeliveredCycleIds(fixture.branch()).size).toBe(1);

        const active = new Set(fixture.session.agent.state.tools.map((t) => t.name));
        expect(active.has('write')).toBe(true);
        expect(active.has('read')).toBe(true);
      },
    );
  }, 40000);

  it('locks the agent to self_compact while a handoff is pending', async () => {
    await withFixture(
      {
        // No summary/continuation scripted: the pending handoff should keep the
        // lock in place; compaction of the single turn is too small and fails,
        // leaving the handoff locked (never a silent unlock).
        responses: [fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE }))],
      },
      async (fixture) => {
        await fixture.session.prompt('Begin.');
        await waitFor(() => {
          const s = readHandoffState(fixture.branch());
          return s?.phase === 'failed' || s?.phase === 'compacting';
        }, 15000);
        const active = fixture.session.agent.state.tools.map((t) => t.name);
        expect(active).toEqual(['self_compact']);
        expect(readHandoffState(fixture.branch())?.note).toBe(NOTE);
      },
    );
  }, 30000);

  for (const order of ['self_compact-first', 'sibling-first'] as const) {
    it(`blocks a sibling tool in a mixed batch (${order})`, async () => {
      const selfCall = fauxToolCall('self_compact', { note_to_self: NOTE });
      const sibling = fauxToolCall('bash', { command: 'echo SNEAK > blocked.txt' });
      const mixed: AssistantMessage = fauxAssistantMessage(
        order === 'self_compact-first' ? [selfCall, sibling] : [sibling, selfCall],
      );
      await withFixture(
        {
          responses: [
            fillerTurn(),
            mixed,
            summary(),
            fauxAssistantMessage('Continued without the blocked side effect.'),
          ],
        },
        async (fixture) => {
          await fixture.session.prompt('Begin.');
          await waitFor(() => readHandoffState(fixture.branch())?.phase === 'delivered', 20000);
          expect(existsSync(join(fixture.dir, 'blocked.txt'))).toBe(false);
          expect(readDeliveredCycleIds(fixture.branch()).size).toBe(1);
        },
      );
    }, 40000);
  }
});

describe('prompt overrides', () => {
  it('sends the editable default instruction as the leading summary system message, and delivers the note separately', async () => {
    let capturedSystem: string | undefined;
    const captureSummary = (context: {
      messages: Array<{ role: string; content: string | Array<{ text?: string }> }>;
    }) => {
      const first = context.messages[0];
      if (first && first.role === 'system') {
        capturedSystem =
          typeof first.content === 'string' ? first.content : first.content.map((c) => c.text ?? '').join('');
      }
      return summary('## Goal\nSUMMARY BODY CONTENT');
    };
    await withFixture(
      {
        responses: [
          fillerTurn(),
          fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE })),
          captureSummary as unknown as AssistantMessage,
          fauxAssistantMessage('Done.'),
        ],
      },
      async (fixture) => {
        await fixture.session.prompt('Begin.');
        await waitFor(() => readHandoffState(fixture.branch())?.phase === 'delivered', 20000);

        expect(capturedSystem).toBe(loadDefaultCompactionInstruction());

        // The verbatim note is delivered as a continuation, separate from the summary.
        const serialized = JSON.stringify(fixture.branch());
        expect(serialized).toContain('<self-compact-continuation>');
        expect(serialized).toContain(NOTE);
        expect(capturedSystem).not.toContain(NOTE);
      },
    );
  }, 40000);
});

describe('recovery', () => {
  it('keeps the note and lock on summary failure, then delivers on explicit retry with the unchanged note', async () => {
    await withFixture(
      {
        responses: [
          fillerTurn(),
          fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE })),
          failingSummary, // provider error during summarization => cancel, stay locked
        ],
      },
      async (fixture) => {
        await fixture.session.prompt('Begin.');
        await waitFor(() => readHandoffState(fixture.branch())?.phase === 'failed', 15000);

        const failed = readHandoffState(fixture.branch());
        expect(failed?.phase).toBe('failed');
        expect(failed?.note).toBe(NOTE);
        expect(fixture.session.agent.state.tools.map((t) => t.name)).toEqual(['self_compact']);

        // Explicit retry: the model calls self_compact again with the same note,
        // then compaction succeeds and the continuation is delivered.
        fixture.faux.appendResponses([
          fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE })),
          summary(),
          fauxAssistantMessage('Recovered.'),
        ]);
        await fixture.session.prompt('Try again.');
        await waitFor(() => readHandoffState(fixture.branch())?.phase === 'delivered', 20000);

        const cycleAfter = readHandoffState(fixture.branch());
        expect(cycleAfter?.phase).toBe('delivered');
        expect(cycleAfter?.cycleId).toBe(failed?.cycleId); // same cycle re-armed, not a new note
        expect(readDeliveredCycleIds(fixture.branch()).size).toBe(1);
      },
    );
  }, 45000);

  it('reconstructs a locked, undelivered handoff on reload without starting a turn', async () => {
    const first = await createFixture({
      responses: [
        fillerTurn(),
        fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE })),
        failingSummary, // fail -> failed + locked
      ],
    });
    const dir = first.dir;
    const sessionFile = first.sessionFile;
    try {
      await first.session.prompt('Begin.');
      await waitFor(() => readHandoffState(first.branch())?.phase === 'failed', 15000);
      first.session.dispose();

      const reopened = await createFixture({
        sessionFile,
        responses: [fauxAssistantMessage(fauxToolCall('bash', { command: 'echo SNEAK > sneak.txt' }))],
      });
      try {
        // Reload reconstructs the failed, undelivered handoff and does not start
        // another turn on its own.
        await new Promise((r) => setTimeout(r, 300));
        const state = readHandoffState(reopened.branch());
        expect(state?.phase).toBe('failed');
        expect(state?.note).toBe(NOTE);
        expect(reopened.faux.state.callCount).toBe(0);

        // The lock still holds functionally: an ordinary tool is blocked via the
        // tool_call gate even though the agent selection was rebuilt on reload.
        await reopened.session.prompt('Try to keep working.');
        await waitFor(() => reopened.faux.state.callCount > 0, 10000);
        await new Promise((r) => setTimeout(r, 300));
        expect(existsSync(join(reopened.dir, 'sneak.txt'))).toBe(false);
        expect(readHandoffState(reopened.branch())?.phase).toBe('failed');
      } finally {
        reopened.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45000);

  it('does not replay a delivered handoff on ordinary reload', async () => {
    const first = await createFixture({
      responses: [
        fillerTurn(),
        fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE })),
        summary(),
        fauxAssistantMessage('Done.'),
      ],
    });
    const dir = first.dir;
    const sessionFile = first.sessionFile;
    try {
      await first.session.prompt('Begin.');
      await waitFor(() => readHandoffState(first.branch())?.phase === 'delivered', 20000);
      first.session.dispose();

      const reopened = await createFixture({ sessionFile, responses: [] });
      try {
        // Give any errant coordinator a chance to (wrongly) act.
        await new Promise((r) => setTimeout(r, 500));
        expect(readHandoffState(reopened.branch())?.phase).toBe('delivered');
        expect(readDeliveredCycleIds(reopened.branch()).size).toBe(1);
        expect(reopened.faux.state.callCount).toBe(0); // no new continuation turn
      } finally {
        reopened.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45000);
});

describe('reconciliation and queued messages', () => {
  // Content-routed responder: order-independent so interleaved/queued turns stay
  // deterministic regardless of how compaction splits turns.
  function textOf(m: unknown): string {
    const msg = m as { content?: unknown } | undefined;
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) return msg.content.map((c: { text?: string }) => c.text ?? '').join(' ');
    return '';
  }
  function summary() {
    return fauxAssistantMessage('## Goal\nWrite result.txt.\n\n## Next Steps\n1. write result.txt with done');
  }
  function respondFor(note: string) {
    return (context: { messages: Array<{ role: string; content: unknown }> }): AssistantMessage => {
      const first = context.messages[0];
      const sys = first && first.role === 'system' ? String((first as { content?: unknown }).content ?? '') : '';
      if (sys.includes('You are compacting a long-running autonomous coding session')) return summary();
      const msgs = context.messages;
      if (msgs.some((m) => m.role === 'toolResult' && textOf(m).includes('result.txt'))) {
        return fauxAssistantMessage('Done.');
      }
      const lastTurnStart = [...msgs].reverse().find((m) => m.role === 'user' || m.role === 'custom');
      const t = textOf(lastTurnStart);
      if (t.includes('self-compact-continuation')) {
        return fauxAssistantMessage(fauxToolCall('write', { path: 'result.txt', content: 'done' }));
      }
      if (t.includes('Also remember to mention X')) return fauxAssistantMessage('Acknowledged the queued request.');
      if (t.includes('Begin the long task')) {
        return fauxAssistantMessage([
          { type: 'text', text: `Working on it. ${'context '.repeat(300)}` },
          fauxToolCall('self_compact', { note_to_self: note }),
        ]);
      }
      return fauxAssistantMessage('ok');
    };
  }

  it("Pi's automatic compaction discharges a pending handoff through to delivery", async () => {
    // A large user prompt drives context past the tiny window, so Pi's own
    // automatic (threshold/overflow) compaction fires on the self_compact turn
    // while the handoff is pending. The extension must reconcile that native
    // compaction (pending -> ready-to-deliver) and deliver exactly once, rather
    // than running a second, self-requested compaction.
    const huge = `Begin the long task. ${'CONTEXT '.repeat(30000)}`;
    await withFixture(
      {
        contextWindow: 4000,
        responses: [
          fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE })),
          summary(),
          fauxAssistantMessage(fauxToolCall('write', { path: 'result.txt', content: 'done' })),
          fauxAssistantMessage('Done.'),
        ],
      },
      async (fixture) => {
        await fixture.session.prompt(huge);
        await waitFor(() => readHandoffState(fixture.branch())?.phase === 'delivered', 20000);

        const phases = statePhases(fixture.branch());
        // Reconciled by session_compact, never our own idle self-compaction.
        expect(phases).toContain('ready-to-deliver');
        expect(phases).not.toContain('compacting');
        expect(compactionCount(fixture.branch())).toBe(1);
        expect(readDeliveredCycleIds(fixture.branch()).size).toBe(1);
        expect(readFileSync(join(fixture.dir, 'result.txt'), 'utf8')).toBe('done');
      },
    );
  }, 40000);

  it('manual /compact discharges a pending handoff recovered on reload', async () => {
    // Simulate a crash that persisted a pending handoff (locked, undelivered)
    // before compaction ran, then reload and let the user run /compact. The
    // successful native compaction must discharge the pending note and deliver
    // once idle without requiring another user prompt (spec 3.3, 5).
    const seed = await createFixture({
      responses: [
        fauxAssistantMessage(fauxToolCall('bash', { command: 'echo working' })),
        fauxAssistantMessage('progress one'),
        fauxAssistantMessage(fauxToolCall('bash', { command: 'echo more' })),
        fauxAssistantMessage('progress two'),
      ],
    });
    const dir = seed.dir;
    const sessionFile = seed.sessionFile;
    try {
      await seed.session.prompt('Do the first part.');
      await seed.session.prompt('Do the second part.');
      // Durable state a crash-during-pending would leave on disk.
      seed.sessionManager.appendCustomEntry(STATE_ENTRY, {
        cycleId: uuidv7(),
        phase: 'pending',
        note: NOTE,
        originalActiveTools: ['read', 'bash', 'edit', 'write'],
        completedCycles: 0,
      });
      seed.session.dispose();

      const reopened = await createFixture({
        sessionFile,
        responses: [
          summary(),
          summary(),
          fauxAssistantMessage(fauxToolCall('write', { path: 'result.txt', content: 'done' })),
          fauxAssistantMessage('Done.'),
        ],
      });
      try {
        await new Promise((r) => setTimeout(r, 200));
        expect(readHandoffState(reopened.branch())?.phase).toBe('pending');

        await reopened.session.compact(); // user runs /compact
        await waitFor(() => readHandoffState(reopened.branch())?.phase === 'delivered', 15000);

        expect(statePhases(reopened.branch())).toContain('ready-to-deliver');
        expect(readDeliveredCycleIds(reopened.branch()).size).toBe(1);
        expect(readFileSync(join(reopened.dir, 'result.txt'), 'utf8')).toBe('done');
      } finally {
        reopened.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45000);

  it('a follow-up queued during a pending handoff does not strand or duplicate the continuation', async () => {
    await withFixture(
      {
        tokensPerSecond: 400,
        responses: Array.from({ length: 20 }, () => respondFor(NOTE) as unknown as AssistantMessage),
      },
      async (fixture) => {
        const running = fixture.session.prompt('Begin the long task.');
        // Enqueue a user follow-up while the self_compact turn is still streaming
        // (i.e., while the handoff is being reserved / pending).
        await waitFor(() => fixture.session.isStreaming, 10000);
        await fixture.session.prompt('Also remember to mention X.', { streamingBehavior: 'followUp' });
        await running;

        await waitFor(() => readHandoffState(fixture.branch())?.phase === 'delivered', 20000);

        const serialized = JSON.stringify(fixture.branch());
        // The queued message was accepted during the pending handoff...
        expect(serialized).toContain('Also remember to mention X');
        // ...and the handoff still completes with exactly one continuation.
        expect(readDeliveredCycleIds(fixture.branch()).size).toBe(1);
        expect(readFileSync(join(fixture.dir, 'result.txt'), 'utf8')).toBe('done');
      },
    );
  }, 45000);
});

describe('print/JSON survival', () => {
  const survivalResponses = () => [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'echo working on the long task' })),
    fauxAssistantMessage(fauxToolCall('self_compact', { note_to_self: NOTE })),
    fauxAssistantMessage('## Goal\nWrite result.txt.\n\n## Next Steps\n1. write result.txt with done'),
    fauxAssistantMessage(fauxToolCall('write', { path: 'result.txt', content: 'done' })),
    fauxAssistantMessage('Done.'),
  ];

  it('pi -p (print mode) completes compaction and continuation before the process exits', async () => {
    const run = await runCli({ mode: 'text', prompt: 'Begin the long task.', responses: survivalResponses() });
    try {
      expect(run.exitCode).toBe(0);
      // The process exited cleanly only after the continuation turn wrote the file.
      expect(existsSync(join(run.dir, 'result.txt'))).toBe(true);
      expect(readFileSync(join(run.dir, 'result.txt'), 'utf8')).toBe('done');
      expect(run.stdout).toContain('Done.');
    } finally {
      run.dispose();
    }
  }, 60000);

  it('pi --mode json completes compaction and continuation before the process exits', async () => {
    const run = await runCli({ mode: 'json', prompt: 'Begin the long task.', responses: survivalResponses() });
    try {
      expect(run.exitCode).toBe(0);
      expect(readFileSync(join(run.dir, 'result.txt'), 'utf8')).toBe('done');
      const types = run.jsonEvents().map((e) => e.type);
      // Compaction ran and a continuation turn started, all before exit.
      expect(types).toContain('compaction_end');
      expect(types.filter((t) => t === 'agent_start').length).toBeGreaterThanOrEqual(2);
    } finally {
      run.dispose();
    }
  }, 60000);
});
