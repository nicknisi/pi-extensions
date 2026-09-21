import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  applyLeadingSystemInstruction,
  buildSummaryStreamFn,
  leadingSystemInstruction,
  resolveCompactionInstruction,
  runSelfCompaction,
  type CompactionPreparation,
  type StreamSimpleFn,
} from './extensions/self-compact/prompts.js';

function streamOf(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end(message);
  return stream;
}

function capturingProvider(response: AssistantMessage) {
  const captured: { context?: TranscriptContext } = {};
  const streamSimple: StreamSimpleFn = (_model, context, _options) => {
    captured.context = context as unknown as TranscriptContext;
    return streamOf(response);
  };
  return { streamSimple, captured };
}

function transcript(systemText: string): TranscriptContext {
  return {
    messages: [
      { role: 'system', content: systemText, timestamp: Date.now() },
      { role: 'user', content: 'summarize this', timestamp: Date.now() },
    ],
  } as unknown as TranscriptContext;
}

function preparation(): CompactionPreparation {
  return {
    firstKeptEntryId: 'keep-1',
    messagesToSummarize: [{ role: 'user', content: [{ type: 'text', text: 'earlier work' }], timestamp: Date.now() }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 4321,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  } as unknown as CompactionPreparation;
}

function fauxModel(): Model<string> {
  return fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', contextWindow: 200000 }] }).getModel();
}

const DEFAULT_INSTRUCTION = 'DEFAULT summary instruction';

describe('prompt overrides', () => {
  it('replaces the leading transcript system instruction, not an obsolete field', () => {
    const ctx = transcript('pi default summarizer prompt');
    applyLeadingSystemInstruction(ctx, 'CUSTOM instruction');
    expect(leadingSystemInstruction(ctx)).toBe('CUSTOM instruction');
    expect(ctx.messages[0]?.role).toBe('system');
  });

  it('inserts a leading system message when the transcript lacks one', () => {
    const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] } as unknown as TranscriptContext;
    applyLeadingSystemInstruction(ctx, 'CUSTOM instruction');
    expect(ctx.messages[0]?.role).toBe('system');
    expect(leadingSystemInstruction(ctx)).toBe('CUSTOM instruction');
  });

  it('prefers a literal --compact-prompt override over the editable default file', () => {
    const resolved = resolveCompactionInstruction({
      compactPromptOverride: 'LITERAL override wins',
      loadDefault: () => DEFAULT_INSTRUCTION,
    });
    expect(resolved).toBe('LITERAL override wins');
  });

  it('falls back to the editable default when there is no override', () => {
    expect(resolveCompactionInstruction({ loadDefault: () => DEFAULT_INSTRUCTION })).toBe(DEFAULT_INSTRUCTION);
    expect(resolveCompactionInstruction({ compactPromptOverride: '   ', loadDefault: () => DEFAULT_INSTRUCTION })).toBe(
      DEFAULT_INSTRUCTION,
    );
  });

  it('sends the resolved instruction as the leading system message of the actual request', async () => {
    const { streamSimple, captured } = capturingProvider(fauxAssistantMessage('## Goal\nfinish the task'));
    const result = await runSelfCompaction({
      preparation: preparation(),
      model: fauxModel(),
      streamSimple,
      loadDefault: () => DEFAULT_INSTRUCTION,
    });
    expect(result.summary).toContain('## Goal');
    expect(captured.context).toBeDefined();
    expect(leadingSystemInstruction(captured.context!)).toBe(DEFAULT_INSTRUCTION);
  });

  it('routes a literal override through the actual summary request', async () => {
    const { streamSimple, captured } = capturingProvider(fauxAssistantMessage('summary body'));
    await runSelfCompaction({
      preparation: preparation(),
      model: fauxModel(),
      streamSimple,
      compactPromptOverride: 'OVERRIDE for this request',
      loadDefault: () => DEFAULT_INSTRUCTION,
    });
    expect(leadingSystemInstruction(captured.context!)).toBe('OVERRIDE for this request');
  });

  it('builds a stream callback that overrides then delegates to the provider', () => {
    let seen: TranscriptContext | undefined;
    const streamSimple: StreamSimpleFn = (_m, context) => {
      seen = context as unknown as TranscriptContext;
      return streamOf(fauxAssistantMessage('x'));
    };
    const fn = buildSummaryStreamFn('INSTRUCTION', streamSimple);
    const ctx = transcript('to be replaced');
    fn(fauxModel(), ctx, undefined);
    expect(leadingSystemInstruction(seen!)).toBe('INSTRUCTION');
  });
});

describe('summary failure', () => {
  it('throws on an empty summary rather than reporting success', async () => {
    const { streamSimple } = capturingProvider(fauxAssistantMessage(''));
    await expect(
      runSelfCompaction({
        preparation: preparation(),
        model: fauxModel(),
        streamSimple,
        loadDefault: () => DEFAULT_INSTRUCTION,
      }),
    ).rejects.toThrow(/empty/);
  });

  it('throws when the summary is only whitespace', async () => {
    const { streamSimple } = capturingProvider(fauxAssistantMessage('   \n  '));
    await expect(
      runSelfCompaction({
        preparation: preparation(),
        model: fauxModel(),
        streamSimple,
        loadDefault: () => DEFAULT_INSTRUCTION,
      }),
    ).rejects.toThrow(/empty/);
  });

  it('throws when the summarization is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { streamSimple } = capturingProvider(fauxAssistantMessage('late summary'));
    await expect(
      runSelfCompaction({
        preparation: preparation(),
        model: fauxModel(),
        streamSimple,
        signal: controller.signal,
        loadDefault: () => DEFAULT_INSTRUCTION,
      }),
    ).rejects.toThrow();
  });
});
